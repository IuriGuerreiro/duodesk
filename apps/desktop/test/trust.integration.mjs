import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { Host } from "../electron/host.mjs";
import {
  createPairingServer,
  createPairingClient,
} from "../../../packages/protocol/src/pairing.ts";
import {
  enrollTranscript,
  reconnectTranscript,
} from "../../../packages/protocol/src/trust.ts";
import { pinnedSocket } from "./helpers/pinned-socket.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nonce = () => randomBytes(32).toString("hex");
const point = (key) => {
  const j = key.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(j.x, "base64url"),
    Buffer.from(j.y, "base64url"),
  ]).toString("hex");
};
const publicKey = (raw) =>
  createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(raw.slice(2, 66), "hex").toString("base64url"),
      y: Buffer.from(raw.slice(66), "hex").toString("base64url"),
    },
    format: "jwk",
  });

test(
  "real host enrolls, pins persistent identity, authenticates both initiation directions, and revokes",
  { skip: !process.env.DUODESK_TEST_HOST, timeout: 60000 },
  async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "duodesk-trust-integration-"),
    );
    const previous = process.env.DUODESK_TEST_SECRET_FILE;
    process.env.DUODESK_TEST_SECRET_FILE = path.join(dir, "test-secrets");
    let host, info, handler;
    const sockets = [],
      events = [],
      eventWaiters = [];
    function event(e) {
      events.push(e);
      for (const w of [...eventWaiters])
        if (w.predicate(e)) {
          eventWaiters.splice(eventWaiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(e);
        }
      if (e.kind === "pairing")
        void handler(e.requestId, e.message, info).then((reply) =>
          host.request("stream_pair_reply", {
            reply: { requestId: e.requestId, ...reply },
          }),
        );
    }
    const waitEvent = (predicate) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Host event timeout")),
          5000,
        );
        eventWaiters.push({ predicate, resolve, timer });
      });
    function launch() {
      host = new Host(process.env.DUODESK_TEST_HOST, event, () => {}, dir);
    }
    try {
      launch();
      const list = await host.request("stream_interfaces");
      const ip = list.find(
        (a) =>
          a.selectable &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
      )?.address;
      assert.ok(ip, "requires a reachable private IPv4 interface");
      assert.equal((await host.request("trust_status")).available, true);
      await host.request("trust_endpoint", { ip });
      let endpoint = (await host.request("trust_status")).endpoint.address;
      handler = await createPairingServer("123456", { features: ["trust-v1"] });
      const started = await host.request("stream_start", {
        ip,
        direction: "phone-to-desktop",
      });
      info = started.invitation;
      const bootstrap = net.connect({
        host: ip,
        port: Number(started.address.split(":")[1]),
      });
      await once(bootstrap, "connect");
      let lines = "";
      const reads = [];
      bootstrap.on("data", (b) => {
        lines += b.toString();
        const at = lines.indexOf("\n");
        if (at >= 0) {
          const line = lines.slice(0, at);
          lines = lines.slice(at + 1);
          reads.shift()?.(line);
        }
      });
      const exchange = (value) =>
        new Promise((resolve) => {
          reads.push(resolve);
          bootstrap.write(value + "\n");
        });
      const client = createPairingClient("123456", started.address, {
        features: ["trust-v1"],
      });
      const proof = await client.challenge(await exchange(client.hello));
      const invitation = JSON.parse(await client.finish(await exchange(proof)));
      bootstrap.destroy();
      assert.deepEqual(client.features, ["trust-v1"]);
      const paired = await pinnedSocket(invitation.url, (cert) =>
        assert.equal(hash(cert.raw), invitation.fingerprint),
      );
      sockets.push(paired);
      const send = (type, fields = {}) =>
        paired.send({ v: 1, sessionId: invitation.sessionId, type, ...fields });
      send("pair", { token: invitation.token });
      assert.equal((await paired.next()).type, "paired");
      const capable = waitEvent(
        (e) =>
          e.kind === "trust" && e.type === "enroll" && e.state === "capable",
      );
      send("enroll_hello");
      await capable;
      await host.request("trust_enroll", {
        action: "start",
        name: "Test phone",
      });
      const request = await paired.next();
      assert.equal(request.type, "enroll_request");
      const phone = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const phoneKey = point(phone.publicKey),
        phoneNonce = nonce();
      const desktopKey = request.key;
      const fields = {
        sessionId: invitation.sessionId,
        certificateFingerprint: invitation.fingerprint,
        tokenHash: hash(Buffer.from(invitation.token, "hex")),
        desktopKey,
        phoneKey,
        desktopNonce: request.nonce,
        phoneNonce,
      };
      send("enroll_accept", {
        key: phoneKey,
        nonce: phoneNonce,
        name: "Test phone",
        signature: sign(
          "sha256",
          Buffer.from(enrollTranscript("phone", fields)),
          phone.privateKey,
        ).toString("hex"),
      });
      const confirm = await paired.next();
      assert.equal(confirm.type, "enroll_confirm");
      assert.equal(
        verify(
          "sha256",
          Buffer.from(enrollTranscript("desktop", fields)),
          publicKey(desktopKey),
          Buffer.from(confirm.signature, "hex"),
        ),
        true,
      );
      assert.equal(
        (await host.request("trust_status")).devices.length,
        0,
        "pending does not authorize",
      );
      const saved = waitEvent(
        (e) => e.kind === "trust" && e.type === "enroll" && e.state === "saved",
      );
      send("enroll_saved");
      assert.equal((await paired.next()).type, "enroll_saved");
      await saved;
      let device = (await host.request("trust_status")).devices[0];
      assert.equal(device.name, "Test phone");
      await host.request("trust_rename", {
        deviceId: device.id,
        name: "Kitchen phone",
      });
      await host.request("stream_stop");
      paired.close();
      host.close();
      launch();
      device = (await host.request("trust_status")).devices[0];
      assert.equal(device.name, "Kitchen phone");
      endpoint = (await host.request("trust_status")).endpoint.address;
      // The certificate is fresh after restart; its public-key identity must stay the same.
      const keyPin = (cert) => {
        const x509 = new X509Certificate(cert.raw);
        assert.equal(point(x509.publicKey), desktopKey);
      };
      async function openLink(response) {
        const link = await pinnedSocket(`wss://${endpoint}/`, keyPin);
        sockets.push(link);
        const challenge = await link.next();
        const cn = nonce();
        const signature =
          response ??
          sign(
            "sha256",
            Buffer.from(
              reconnectTranscript({
                desktopKey,
                phoneKey,
                serverNonce: challenge.nonce,
                clientNonce: cn,
              }),
            ),
            phone.privateKey,
          ).toString("hex");
        link.send({ v: 1, type: "auth", key: phoneKey, nonce: cn, signature });
        return { link, signature };
      }
      const first = await openLink();
      assert.equal((await first.link.next()).type, "authenticated");
      const replay = await openLink(first.signature);
      await assert.rejects(replay.link.next(), /closed/);
      const local = await host.request("trust_connect", {
        deviceId: device.id,
        direction: "phone-to-desktop",
      });
      const ask = await first.link.next();
      assert.equal(ask.requestId, local);
      await assert.rejects(
        host.request("trust_start", { requestId: local }),
        /approved|expired/,
      );
      const accepted = waitEvent(
        (e) =>
          e.kind === "trust" && e.type === "accepted" && e.requestId === local,
      );
      first.link.send({ v: 1, type: "connect_accept", requestId: local });
      await accepted;
      const fresh = await host.request("trust_start", { requestId: local });
      assert.notEqual(fresh.invitation.token, invitation.token);
      await host.request("trust_ready", { requestId: local });
      assert.equal((await first.link.next()).type, "invitation");
      await assert.rejects(
        host.request("trust_start", { requestId: local }),
        /approved|expired/,
      );
      const cancelledSession = waitEvent(
        (e) =>
          e.kind === "state" &&
          e.sessionId === fresh.invitation.sessionId &&
          e.state === "stopped",
      );
      first.link.send({ v: 1, type: "connect_cancel", requestId: local });
      await cancelledSession;
      await assert.rejects(
        pinnedSocket(fresh.invitation.url, (cert) =>
          assert.equal(hash(cert.raw), fresh.invitation.fingerprint),
        ),
      );
      await host.request("stream_stop");
      const remote = randomBytes(16).toString("hex");
      const prompted = waitEvent(
        (e) =>
          e.kind === "trust" && e.type === "request" && e.requestId === remote,
      );
      first.link.send({
        v: 1,
        type: "connect_request",
        requestId: remote,
        direction: "desktop-to-phone",
      });
      await prompted;
      await assert.rejects(
        host.request("trust_start", { requestId: remote }),
        /approved|expired/,
      );
      await host.request("trust_respond", { requestId: remote, accept: true });
      assert.equal((await first.link.next()).type, "connect_accept");
      await host.request("trust_start", { requestId: remote });
      await host.request("trust_ready", { requestId: remote });
      assert.equal((await first.link.next()).type, "invitation");
      await host.request("trust_forget", { deviceId: device.id });
      assert.equal((await first.link.next()).type, "forget");
      await first.link.closed;
      const forgotten = await openLink();
      await assert.rejects(forgotten.link.next(), /closed/);
      assert.deepEqual((await host.request("trust_status")).devices, []);
      host.close();
      launch();
      assert.deepEqual((await host.request("trust_status")).devices, []);
      assert.ok(
        events.every(
          (e) =>
            !(
              e.kind === "trust" && JSON.stringify(e).includes(invitation.token)
            ),
        ),
      );
    } finally {
      for (const s of sockets) s.close();
      host?.close();
      for (const w of eventWaiters) clearTimeout(w.timer);
      if (previous === undefined) delete process.env.DUODESK_TEST_SECRET_FILE;
      else process.env.DUODESK_TEST_SECRET_FILE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
