import test from "node:test";
import assert from "node:assert/strict";
import {
  createPairingServer,
  createPairingClient,
  createPairingQrPayload,
  parsePairingQrPayload,
  parseDesktopAddress,
  verificationCode,
} from "../src/pairing.ts";
const invitation = () => ({
  v: 1,
  direction: "phone-to-desktop",
  sessionId: "a".repeat(32),
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  url: "wss://192.168.1.2:12345/",
  expiresAt: Date.now() + 120000,
});
async function exchange(code = "000123") {
  const serve = await createPairingServer("000123");
  const client = createPairingClient(code, "192.168.1.2:39871");
  const info = invitation();
  const challenge = await serve("request", client.hello, info);
  const proof = await client.challenge(challenge.message);
  return { serve, client, info, proof };
}
test("SRP mutual authentication encrypts and recovers the pinned invitation once", async () => {
  const { serve, client, info, proof } = await exchange();
  const verified = await serve("request", proof, info);
  assert.equal(verified.complete, true);
  assert.ok(!verified.message.includes(info.token));
  assert.ok(!verified.message.includes(info.fingerprint));
  assert.deepEqual(JSON.parse(await client.finish(verified.message)), info);
  await assert.rejects(serve("next", client.hello, info));
  await assert.rejects(client.finish(verified.message));
});
test("wrong code, zero public values, malformed fields and expiry are rejected", async () => {
  const { serve, info, proof } = await exchange("999999");
  await assert.rejects(serve("request", proof, info));
  const host = await createPairingServer("123456");
  const zero = JSON.stringify({ v: 1, type: "hello", public: "0".repeat(512) });
  await host("zero", zero, info);
  await assert.rejects(
    host(
      "zero",
      JSON.stringify({ v: 1, type: "proof", proof: "0".repeat(64) }),
      info,
    ),
  );
  await assert.rejects(
    host(
      "extra",
      JSON.stringify({
        v: 1,
        type: "hello",
        public: "a".repeat(512),
        extra: true,
      }),
      info,
    ),
  );
  await assert.rejects(
    host("expired", zero, { ...info, expiresAt: Date.now() }),
  );
});
test("server proof and ciphertext tampering fail closed", async () => {
  for (const field of ["proof", "encrypted", "nonce"]) {
    const { serve, client, info, proof } = await exchange();
    const verified = JSON.parse((await serve("request", proof, info)).message);
    verified[field] =
      (verified[field][0] === "a" ? "b" : "a") + verified[field].slice(1);
    await assert.rejects(client.finish(JSON.stringify(verified)));
  }
});
test("proof cannot move to another connection or receiver address", async () => {
  const { serve, client, info, proof } = await exchange();
  await assert.rejects(serve("different", proof, info));
  const host = await createPairingServer("000123");
  const other = createPairingClient("000123", "192.168.1.3:39871");
  const challenge = await host("r", other.hello, info);
  const response = await host(
    "r",
    await other.challenge(challenge.message),
    info,
  );
  await assert.rejects(other.finish(response.message));
  const bad = createPairingClient("000123", "192.168.1.2:39871");
  await assert.rejects(
    bad.challenge(
      JSON.stringify({
        v: 1,
        type: "challenge",
        salt: "a".repeat(64),
        public: "0".repeat(512),
      }),
    ),
  );
  assert.ok(client);
});
test("only literal private IPv4 endpoints and six ASCII digits are accepted", async () => {
  for (const address of [
    "127.0.0.1:1",
    "8.8.8.8:80",
    "example.com:80",
    "192.168.1.2:0",
    "192.168.1.2:65536",
    "192.168.1.2:80/",
    "192.168.001.2:80",
    "169.255.1.1:80",
  ])
    assert.throws(() => parseDesktopAddress(address));
  for (const address of ["10.1.2.3:1234", "172.31.2.3:65535", "169.254.1.2:12"])
    assert.equal(parseDesktopAddress(address), address);
  assert.throws(() => createPairingClient("12345", "192.168.1.2:1234"));
  assert.throws(() => createPairingClient("123456\n", "192.168.1.2:1234"));
  await assert.rejects(createPairingServer("123456\n"));
  for (let i = 0; i < 100; i++) assert.match(verificationCode(), /^\d{6}$/);
});
test("pairing QR contains only the strict address and six-digit code payload", () => {
  const payload = createPairingQrPayload("192.168.1.20:39871", "000123");
  assert.equal(
    payload,
    "duodesk-pair://connect?v=1&address=192.168.1.20%3A39871&code=000123",
  );
  assert.deepEqual(parsePairingQrPayload(payload), {
    address: "192.168.1.20:39871",
    code: "000123",
  });
  for (const invalid of [
    JSON.stringify(invitation()),
    `${payload}&token=${"a".repeat(64)}`,
    payload.replace("v=1", "v=2"),
    payload.replace("192.168.1.20", "8.8.8.8"),
    payload.replace("code=000123", "code=١٢٣٤٥٦"),
    payload.replace("code=000123", "code=123"),
    `${payload}\n`,
    payload.replace("&code=000123", "&code=000123&code=000123"),
    payload.replace("%3A", ":"),
    payload.replace("duodesk-pair://connect", "https://connect"),
  ])
    assert.throws(() => parsePairingQrPayload(invalid));
  assert.throws(() => createPairingQrPayload("192.168.1.20:39871", "123"));
});
