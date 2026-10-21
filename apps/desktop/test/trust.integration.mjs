import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { Host } from "../electron/host.mjs";
import { TrustStore } from "../electron/trust-store.mjs";
import { TrustBackend } from "../electron/trust-backend.mjs";
import { openPinnedWebSocket } from "./tls-websocket.mjs";
import { trustProofBytes } from "../../../packages/protocol/src/trust.ts";

function secureStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(text) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(text, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected host event did not arrive");
}
async function availablePort(ip) {
  const server = net.createServer();
  server.listen(0, ip);
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function boot(store) {
  const events = [];
  const backend = new TrustBackend(store, (event) => events.push(event));
  const host = new Host(
    path.resolve(
      `bin/duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
    ),
    (event) => {
      if (!backend.onEvent(event, host)) events.push(event);
    },
    () => backend.reset(),
  );
  return { host, backend, events };
}
test(
  "persistent trust enrolls only after approval, survives restart, reconnects into normal Session, and revokes",
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "duodesk-trust-"));
    const storage = secureStorage();
    const file = path.join(dir, "trust.enc");
    const store = new TrustStore(file, storage, "linux");
    await store.load();
    let runtime = boot(store);
    const sockets = [];
    try {
      const { host, backend, events } = runtime;
      const ip = (await host.request("stream_interfaces")).find(
        (a) => a.selectable,
      ).address;
      await store.initialize(() => host.request("identity_generate"));
      const port = await availablePort(ip);
      await store.save({ ...store.data, port });
      await backend.beforeStart(host, ip);
      const { invitation } = await host.request("stream_start", { ip });
      const ws = await openPinnedWebSocket(
        invitation.url,
        invitation.fingerprint,
      );
      sockets.push(ws);
      ws.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "pair",
        token: invitation.token,
      });
      assert.equal((await ws.next()).type, "paired");
      const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = keys.publicKey.export({ format: "jwk" });
      const raw = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]);
      const phoneId = createHash("sha256").update(raw).digest("hex");
      ws.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "trust_enroll",
        phoneId,
        name: "Test phone",
        publicKey: raw.toString("hex"),
      });
      const request = (
        await waitFor(() => events.find((e) => e.kind === "trust_enrollment"))
      ).request;
      await assert.rejects(ws.next(40), /timeout/);
      assert.equal(store.data.devices.length, 0);
      await backend.command(host, "trust_approve", {
        requestId: request.requestId,
        approve: true,
      });
      const ack = await ws.next();
      assert.equal(ack.type, "trust_committed");
      assert.equal(ack.phoneId, phoneId);
      assert.equal(ack.fingerprint, invitation.fingerprint);
      const encrypted = await readFile(file);
      assert.equal(
        encrypted.includes(Buffer.from(store.data.identity.privateKeyDer)),
        false,
      );
      assert.equal(encrypted.includes(Buffer.from(phoneId)), false);
      if (process.platform !== "win32")
        assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dir), ["trust.enc"]);
      const originalKey = store.data.identity.privateKeyDer;
      const originalFingerprint = store.fingerprint();
      host.close();
      const restartedStore = new TrustStore(file, storage, "linux");
      await restartedStore.load();
      assert.equal(restartedStore.data.identity.privateKeyDer, originalKey);
      runtime = boot(restartedStore);
      assert.equal(runtime.backend.status().enabled, false);
      const status = await runtime.backend.command(
        runtime.host,
        "trust_allow",
        { ip, allow: true },
      );
      assert.equal(status.address, `${ip}:${port}`);
      assert.equal(status.fingerprint, originalFingerprint);
      assert.equal(status.devices[0].phoneId, phoneId);
      assert.equal(JSON.stringify(status).includes(originalKey), false);
      const reconnect = await openPinnedWebSocket(
        `wss://${status.address}/`,
        status.fingerprint,
      );
      sockets.push(reconnect);
      reconnect.send({ v: 1, type: "trust_connect", phoneId });
      const challenge = await reconnect.next();
      const proof = {
        v: 1,
        type: "trust_proof",
        phoneId,
        signature: sign(
          "sha256",
          trustProofBytes(challenge.nonce, challenge.fingerprint, phoneId),
          keys.privateKey,
        ).toString("hex"),
      };
      reconnect.send(proof);
      const response = await reconnect.next();
      assert.equal(response.type, "trust_invitation");
      const reconnected = await waitFor(() =>
        runtime.events.find((e) => e.kind === "trust_reconnected"),
      );
      assert.deepEqual(response.invitation, reconnected.invitation);
      assert.equal(response.invitation.fingerprint, invitation.fingerprint);
      const stream = await openPinnedWebSocket(
        response.invitation.url,
        response.invitation.fingerprint,
      );
      sockets.push(stream);
      stream.send({
        v: 1,
        sessionId: response.invitation.sessionId,
        type: "pair",
        token: response.invitation.token,
      });
      assert.equal((await stream.next()).type, "paired");
      stream.send({
        v: 1,
        sessionId: response.invitation.sessionId,
        type: "offer",
        sdp: "offer from reconnected phone",
      });
      assert.equal(
        (await waitFor(() => runtime.events.find((e) => e.kind === "signal")))
          .signal.sdp,
        "offer from reconnected phone",
      );
      await runtime.host.request("stream_send", {
        signal: {
          v: 1,
          sessionId: response.invitation.sessionId,
          type: "answer",
          sdp: "answer routed to new session",
        },
      });
      assert.equal((await stream.next()).sdp, "answer routed to new session");
      await runtime.host.request("stream_stop");
      assert.equal((await stream.next()).type, "stop");
      const inflight = await openPinnedWebSocket(
        `wss://${status.address}/`,
        status.fingerprint,
      );
      sockets.push(inflight);
      inflight.send({ v: 1, type: "trust_connect", phoneId });
      const lastChallenge = await inflight.next();
      await runtime.backend.command(runtime.host, "trust_revoke", { phoneId });
      inflight.send({
        v: 1,
        type: "trust_proof",
        phoneId,
        signature: sign(
          "sha256",
          trustProofBytes(
            lastChallenge.nonce,
            lastChallenge.fingerprint,
            phoneId,
          ),
          keys.privateKey,
        ).toString("hex"),
      });
      assert.equal(await inflight.next(), null);
      const retry = await openPinnedWebSocket(
        `wss://${status.address}/`,
        status.fingerprint,
      );
      sockets.push(retry);
      retry.send({ v: 1, type: "trust_connect", phoneId });
      assert.equal(await retry.next(), null);
      assert.equal(restartedStore.data.devices.length, 0);
      await runtime.backend.command(runtime.host, "trust_allow", {
        ip,
        allow: false,
      });
      assert.equal(runtime.backend.status().enabled, false);
      await assert.rejects(
        openPinnedWebSocket(`wss://${status.address}/`, status.fingerprint),
      );
      assert.equal(restartedStore.fingerprint(), originalFingerprint);
    } finally {
      sockets.forEach((s) => s.close());
      runtime.host.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "secure store encryption and filesystem failures preserve pinned data and permit ephemeral ordinary pairing",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "duodesk-store-fail-"));
    const storage = secureStorage();
    const file = path.join(dir, "trust.enc");
    const store = new TrustStore(file, storage, "linux");
    let runtime = boot(store);
    try {
      await store.load();
      await store.initialize(() => runtime.host.request("identity_generate"));
      const bytes = await readFile(file);
      const fingerprint = store.fingerprint();
      storage.encryptString = () => {
        throw new Error("Secure store temporarily locked");
      };
      await assert.rejects(
        store.save({ ...store.data, address: "192.168.1.2:42889" }),
      );
      assert.deepEqual(await readFile(file), bytes);
      assert.equal(store.fingerprint(), fingerprint);
      runtime.host.close();
      const failedStore = new TrustStore(
        path.join(dir, "missing.enc"),
        storage,
        "linux",
      );
      await failedStore.load();
      runtime = boot(failedStore);
      const ip = (await runtime.host.request("stream_interfaces")).find(
        (a) => a.selectable,
      ).address;
      await runtime.backend.beforeStart(runtime.host, ip);
      assert.equal(runtime.backend.status().available, false);
      const result = await runtime.host.request("stream_start", { ip });
      assert.ok(result.invitation.token);
      assert.deepEqual(await readFile(file), bytes);
      const blocked = path.join(dir, "not-a-directory");
      await writeFile(blocked, "occupied");
      const diskStore = new TrustStore(
        path.join(blocked, "trust.enc"),
        secureStorage(),
        "linux",
      );
      const diskBackend = new TrustBackend(diskStore, () => {});
      await diskBackend.beforeStart(runtime.host, ip);
      assert.equal(diskBackend.status().available, false);
      assert.ok(
        (await runtime.host.request("stream_start", { ip })).invitation.token,
      );
      assert.equal(store.fingerprint(), fingerprint);
    } finally {
      runtime.host.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "failed approval persistence sends no commit, disables reconnect and preserves the ordinary paired stream",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "duodesk-approve-fail-"));
    const storage = secureStorage();
    const store = new TrustStore(path.join(dir, "trust.enc"), storage, "linux");
    const { host, backend, events } = boot(store);
    let ws;
    try {
      await store.load();
      const ip = (await host.request("stream_interfaces")).find(
        (a) => a.selectable,
      ).address;
      await store.initialize(() => host.request("identity_generate"));
      await store.save({ ...store.data, port: await availablePort(ip) });
      await backend.command(host, "trust_allow", { ip, allow: true });
      const { invitation } = await host.request("stream_start", { ip });
      ws = await openPinnedWebSocket(invitation.url, invitation.fingerprint);
      ws.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "pair",
        token: invitation.token,
      });
      assert.equal((await ws.next()).type, "paired");
      const { publicKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      const jwk = publicKey.export({ format: "jwk" });
      const raw = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]);
      const phoneId = createHash("sha256").update(raw).digest("hex");
      ws.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "trust_enroll",
        phoneId,
        name: "Phone",
        publicKey: raw.toString("hex"),
      });
      const request = (
        await waitFor(() => events.find((e) => e.kind === "trust_enrollment"))
      ).request;
      const encrypted = await readFile(store.file);
      storage.encryptString = () => {
        throw new Error("OS secure storage locked");
      };
      await assert.rejects(
        backend.command(host, "trust_approve", {
          requestId: request.requestId,
          approve: true,
        }),
      );
      await assert.rejects(ws.next(40), /timeout/);
      assert.deepEqual(await readFile(store.file), encrypted);
      assert.equal(store.data.devices.length, 0);
      assert.equal(backend.status().available, false);
      assert.equal(backend.status().enabled, false);
      assert.ok(
        events.some(
          (e) =>
            e.kind === "trust_status" &&
            !e.status.available &&
            !e.status.enabled,
        ),
      );
      ws.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "offer",
        sdp: "ordinary stream still active",
      });
      assert.equal(
        (await waitFor(() => events.find((e) => e.kind === "signal"))).signal
          .sdp,
        "ordinary stream still active",
      );
      await host.request("stream_stop");
      assert.equal((await ws.next()).type, "stop");
    } finally {
      ws?.close();
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
