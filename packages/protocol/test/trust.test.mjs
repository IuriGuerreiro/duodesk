import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  parseTrustSignal,
  parseTrustReconnect,
  trustProofBytes,
} from "../src/trust.ts";
const sessionId = "1".repeat(32);
const phoneId = "2".repeat(64);
const fingerprint = "3".repeat(64);
const nonce = "4".repeat(64);
test("trust proof signs the exact domain-separated raw challenge bytes with DER ECDSA SHA256", () => {
  const bytes = trustProofBytes(nonce, fingerprint, phoneId);
  assert.deepEqual(
    Buffer.from(bytes),
    Buffer.concat([
      Buffer.from("DuoDesk trusted reconnect v1\n", "ascii"),
      Buffer.from(nonce, "hex"),
      Buffer.from(fingerprint, "hex"),
      Buffer.from(phoneId, "hex"),
    ]),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const signature = sign("sha256", bytes, privateKey);
  assert.equal(signature[0], 0x30);
  assert.equal(verify("sha256", bytes, publicKey, signature), true);
  assert.equal(
    verify(
      "sha256",
      trustProofBytes(nonce, phoneId, fingerprint),
      publicKey,
      signature,
    ),
    false,
  );
  assert.throws(() => trustProofBytes("A".repeat(64), fingerprint, phoneId));
});
test("trust enrollment, commit and rejection require exact session-bound fields", () => {
  const enroll = {
    v: 1,
    sessionId,
    type: "trust_enroll",
    phoneId,
    name: "Phone",
    publicKey: "04" + "5".repeat(128),
  };
  const commit = {
    v: 1,
    sessionId,
    type: "trust_committed",
    phoneId,
    fingerprint,
    address: "192.168.1.2:42889",
  };
  const rejected = {
    v: 1,
    sessionId,
    type: "trust_rejected",
    phoneId,
    reason: "Declined",
  };
  for (const value of [enroll, commit, rejected]) {
    assert.deepEqual(parseTrustSignal(JSON.stringify(value), sessionId), value);
    assert.throws(() =>
      parseTrustSignal(JSON.stringify(value), "9".repeat(32)),
    );
    assert.throws(() =>
      parseTrustSignal(JSON.stringify({ ...value, extra: true }), sessionId),
    );
  }
  for (const changed of [
    { name: "" },
    { name: "é".repeat(41) },
    { name: "Phone\n" },
    { publicKey: "05" + "5".repeat(128) },
  ])
    assert.throws(() =>
      parseTrustSignal(JSON.stringify({ ...enroll, ...changed }), sessionId),
    );
  assert.throws(() =>
    parseTrustSignal(
      JSON.stringify({ ...commit, address: "999.1.1.1:0" }),
      sessionId,
    ),
  );
});
test("reconnect accepts exact messages and rejects extensions, wrong versions and expired invitations", () => {
  for (const value of [
    { v: 1, type: "trust_connect", phoneId },
    { v: 1, type: "trust_challenge", phoneId, fingerprint, nonce },
    { v: 1, type: "trust_proof", phoneId, signature: "30".repeat(70) },
  ]) {
    assert.deepEqual(parseTrustReconnect(JSON.stringify(value)), value);
    assert.throws(() =>
      parseTrustReconnect(JSON.stringify({ ...value, extra: true })),
    );
    assert.throws(() =>
      parseTrustReconnect(JSON.stringify({ ...value, v: 2 })),
    );
  }
  const invitation = {
    v: 1,
    sessionId,
    url: "wss://192.168.1.2:12345/",
    token: phoneId,
    fingerprint,
    expiresAt: 120000,
  };
  const message = { v: 1, type: "trust_invitation", invitation };
  assert.deepEqual(
    parseTrustReconnect(JSON.stringify(message), 100000),
    message,
  );
  assert.throws(() => parseTrustReconnect(JSON.stringify(message), 120000));
});
