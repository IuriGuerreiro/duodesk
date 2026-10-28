import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  enrollTranscript,
  reconnectTranscript,
  isSignature,
  isPublicKey,
  parseEnrollMessage,
  parseLinkMessage,
  parseRememberedAddress,
  parseRememberedRecord,
  rememberedCandidates,
  deviceName,
} from "../src/trust.ts";
import { createPairingClient, createPairingServer } from "../src/pairing.ts";

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/trust-v1.json", import.meta.url), "utf8"),
);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const publicKey = (hex) => {
  const raw = Buffer.from(hex, "hex");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
};
const valid = (key, transcript, signature) =>
  verify(
    "sha256",
    Buffer.from(transcript),
    publicKey(key),
    Buffer.from(signature, "hex"),
  );

test("shared vectors: canonical keys, fingerprints, transcripts and DER signatures", () => {
  const { desktop, phone, enroll, reconnect } = vectors;
  for (const device of [desktop, phone]) {
    assert.ok(isPublicKey(device.publicKey));
    assert.equal(sha(Buffer.from(device.publicKey, "hex")), device.fingerprint);
  }
  assert.equal(enroll.tokenHash, sha(Buffer.from(vectors.token, "hex")));
  const fields = {
    sessionId: enroll.sessionId,
    certificateFingerprint: enroll.certificateFingerprint,
    tokenHash: enroll.tokenHash,
    desktopKey: enroll.desktopKey,
    phoneKey: enroll.phoneKey,
    desktopNonce: enroll.desktopNonce,
    phoneNonce: enroll.phoneNonce,
  };
  assert.equal(enrollTranscript("desktop", fields), enroll.desktopTranscript);
  assert.equal(enrollTranscript("phone", fields), enroll.phoneTranscript);
  assert.equal(sha(enroll.desktopTranscript), enroll.desktopTranscriptSha256);
  assert.ok(isSignature(enroll.desktopSignature));
  assert.ok(isSignature(enroll.phoneSignature));
  assert.ok(
    valid(desktop.publicKey, enroll.desktopTranscript, enroll.desktopSignature),
  );
  assert.ok(
    valid(phone.publicKey, enroll.phoneTranscript, enroll.phoneSignature),
  );
  // A signature cannot be replayed as the other role or another key.
  assert.ok(
    !valid(desktop.publicKey, enroll.phoneTranscript, enroll.desktopSignature),
  );
  assert.ok(
    !valid(phone.publicKey, enroll.desktopTranscript, enroll.desktopSignature),
  );
  const r = reconnectTranscript({
    desktopKey: reconnect.desktopKey,
    phoneKey: reconnect.phoneKey,
    serverNonce: reconnect.serverNonce,
    clientNonce: reconnect.clientNonce,
  });
  assert.equal(r, reconnect.transcript);
  assert.ok(valid(phone.publicKey, r, reconnect.phoneSignature));
  const replay = reconnectTranscript({
    ...reconnect,
    serverNonce: "00".repeat(32),
  });
  assert.ok(!valid(phone.publicKey, replay, reconnect.phoneSignature));
});

test("transcripts reject malformed or identical keys", () => {
  const e = vectors.enroll;
  assert.throws(() =>
    enrollTranscript("desktop", { ...e, phoneKey: e.desktopKey }),
  );
  assert.throws(() =>
    enrollTranscript("desktop", { ...e, desktopNonce: "AB".repeat(32) }),
  );
  assert.throws(() =>
    enrollTranscript("desktop", { ...e, sessionId: "short" }),
  );
});

test("DER signature shape is strict", () => {
  assert.ok(!isSignature("30" + "00"));
  assert.ok(!isSignature(vectors.enroll.desktopSignature.toUpperCase()));
  assert.ok(!isSignature(vectors.enroll.desktopSignature + "00"));
  // r = 0x80.. without the sign padding is a negative integer.
  assert.ok(!isSignature("3006020180020101"));
  assert.ok(isSignature("300602010102010f"));
  // Non-minimal leading zero.
  assert.ok(!isSignature("30070202000102010f"));
});

test("enrollment messages enforce exact fields, session and sender", () => {
  const sessionId = vectors.enroll.sessionId;
  const request = {
    v: 1,
    sessionId,
    type: "enroll_request",
    key: vectors.phone.publicKey,
    nonce: "aa".repeat(32),
    name: "Pixel 8",
  };
  assert.deepEqual(
    parseEnrollMessage(JSON.stringify(request), { sessionId, from: "phone" }),
    request,
  );
  for (const bad of [
    { ...request, extra: 1 },
    { ...request, sessionId: "f".repeat(32) },
    { ...request, key: "05" + request.key.slice(2) },
    { ...request, name: "‮evil" },
    { ...request, name: "" },
  ])
    assert.throws(() =>
      parseEnrollMessage(JSON.stringify(bad), { sessionId, from: "phone" }),
    );
  // Only the phone announces support.
  const hello = JSON.stringify({ v: 1, sessionId, type: "enroll_hello" });
  assert.ok(parseEnrollMessage(hello, { sessionId, from: "phone" }));
  assert.throws(() =>
    parseEnrollMessage(hello, { sessionId, from: "desktop" }),
  );
});

test("link messages are role-scoped and bounded", () => {
  const invitation = JSON.stringify({
    v: 1,
    type: "invitation",
    requestId: "a".repeat(32),
    invitation: "{}",
  });
  assert.equal(parseLinkMessage(invitation, "desktop").type, "invitation");
  assert.throws(() => parseLinkMessage(invitation, "phone"));
  const request = JSON.stringify({
    v: 1,
    type: "connect_request",
    requestId: "b".repeat(32),
    direction: "desktop-to-phone",
  });
  assert.equal(parseLinkMessage(request, "phone").type, "connect_request");
  assert.equal(parseLinkMessage(request, "desktop").type, "connect_request");
  assert.throws(() =>
    parseLinkMessage(
      JSON.stringify({
        v: 1,
        type: "connect_request",
        requestId: "b".repeat(32),
        direction: "sideways",
      }),
      "phone",
    ),
  );
  assert.throws(() => parseLinkMessage("x".repeat(5000), "phone"));
});

test("remembered endpoints are LAN only and adverts carry no identity", () => {
  assert.equal(parseRememberedAddress("192.168.1.5:4000"), "192.168.1.5:4000");
  assert.equal(
    parseRememberedAddress("169.254.10.2:4000"),
    "169.254.10.2:4000",
  );
  assert.throws(
    () => parseRememberedAddress("100.100.1.1:4000"),
    /local network/,
  );
  assert.throws(() => parseRememberedAddress("8.8.8.8:4000"));
  const record = {
    instance: "DuoDeskR-0a1b2c3d",
    hosts: ["fe80::1", "100.70.0.1", "10.0.0.4"],
    port: 41000,
    txt: { v: "1", role: "desktop", name: "Office\u0007 PC" },
  };
  assert.deepEqual(parseRememberedRecord(record), {
    id: "DuoDeskR-0a1b2c3d",
    name: "Office PC",
    address: "10.0.0.4:41000",
  });
  assert.equal(
    parseRememberedRecord({ ...record, instance: "DuoDesk-0a1b2c3d" }),
    null,
  );
  assert.deepEqual(
    rememberedCandidates("10.0.0.4:41000", undefined, [
      { id: "a", name: "x", address: "10.0.0.4:41000" },
      { id: "b", name: "y", address: "10.0.0.9:41000" },
    ]),
    ["10.0.0.4:41000", "10.0.0.9:41000"],
  );
  assert.equal(
    rememberedCandidates(
      undefined,
      undefined,
      Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        name: "x",
        address: `10.0.0.${i + 1}:4000`,
      })),
    ).length,
    8,
  );
  assert.equal(deviceName("  My‏ PC  "), "My PC");
});

const invitation = () => ({
  v: 1,
  direction: "phone-to-desktop",
  sessionId: "a".repeat(32),
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  url: "wss://192.168.1.2:12345/",
  expiresAt: Date.now() + 120000,
});

test("pairing v2 authenticates negotiated features and keeps the v1 invitation exact", async () => {
  const serve = await createPairingServer("000123", { features: ["trust-v1"] });
  const client = createPairingClient("000123", "192.168.1.2:39871", {
    features: ["trust-v1", "future-x"],
  });
  const info = invitation();
  const challenge = await serve("r", client.hello, info);
  assert.equal(JSON.parse(challenge.message).v, 2);
  const proof = await client.challenge(challenge.message);
  assert.ok(client.challenged);
  const verified = await serve("r", proof, info);
  assert.deepEqual(JSON.parse(await client.finish(verified.message)), info);
  assert.deepEqual(client.features, ["trust-v1"]);
});

test("a v2 desktop still serves v1 phones unchanged", async () => {
  const serve = await createPairingServer("000123", { features: ["trust-v1"] });
  const client = createPairingClient("000123", "192.168.1.2:39871");
  const info = invitation();
  const challenge = await serve("r", client.hello, info);
  assert.equal(JSON.parse(challenge.message).v, 1);
  const verified = await serve(
    "r",
    await client.challenge(challenge.message),
    info,
  );
  assert.deepEqual(JSON.parse(await client.finish(verified.message)), info);
  assert.deepEqual(client.features, []);
});

test("a desktop offering no features answers v2 with an empty authenticated list", async () => {
  const plain = await createPairingServer("000123");
  const v2 = createPairingClient("000123", "192.168.1.2:39871", {
    features: ["trust-v1"],
  });
  const served = await plain("r", v2.hello, invitation());
  const verified = await plain(
    "r",
    await v2.challenge(served.message),
    invitation(),
  );
  await v2.finish(verified.message);
  assert.deepEqual(v2.features, []);
});

test("features cannot be downgraded or swapped between versions", async () => {
  const serve = await createPairingServer("000123", { features: ["trust-v1"] });
  const v1 = createPairingClient("000123", "192.168.1.2:39871");
  const v2 = createPairingClient("000123", "192.168.1.2:39871", {
    features: ["trust-v1"],
  });
  const info = invitation();
  // A v1 challenge is not accepted by a v2 client (and vice versa).
  const v1Challenge = await serve("a", v1.hello, info);
  await assert.rejects(v2.challenge(v1Challenge.message));
  assert.equal(v2.challenged, false);
  const v2Challenge = await serve(
    "b",
    createPairingClient("000123", "192.168.1.2:39871", {
      features: ["trust-v1"],
    }).hello,
    info,
  );
  await assert.rejects(v1.challenge(v2Challenge.message));
});
