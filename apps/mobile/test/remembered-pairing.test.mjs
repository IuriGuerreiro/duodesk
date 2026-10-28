import test from "node:test";
import assert from "node:assert/strict";
import { authenticatePairing } from "../src/features/pairing/authenticate.ts";
import { createPairingServer } from "../../../packages/protocol/src/pairing.ts";
const invitation = () => ({
  v: 1,
  direction: "phone-to-desktop",
  sessionId: "a".repeat(32),
  url: "wss://192.168.1.2:12345/",
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  expiresAt: Date.now() + 120000,
});
async function fixture({
  legacy = false,
  tamper = false,
  cancelled = () => false,
} = {}) {
  const serve = await createPairingServer("123456", { features: ["trust-v1"] });
  const info = invitation();
  let opens = 0,
    closes = 0,
    requestId = "";
  return {
    info,
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    run: () =>
      authenticatePairing({
        address: "192.168.1.2:12345",
        code: "123456",
        features: ["trust-v1"],
        cancelled,
        onChallenge: () => {},
        close: async () => {
          closes++;
        },
        request: async (_address, text, fresh) => {
          if (fresh) {
            opens++;
            requestId = String(opens);
          }
          const message = JSON.parse(text);
          if (legacy && message.v !== 1)
            throw new Error("Legacy desktop closed unsupported hello");
          const reply = await serve(requestId, text, info);
          if (tamper && reply.complete) {
            const v = JSON.parse(reply.message);
            v.proof = "0".repeat(64);
            return JSON.stringify(v);
          }
          return reply.message;
        },
      }),
  };
}
test("new phone retries legacy pairing on a fresh connection and receives no trust capability", async () => {
  const f = await fixture({ legacy: true });
  const result = await f.run();
  assert.deepEqual(JSON.parse(result.invitation), f.info);
  assert.deepEqual(result.features, []);
  assert.equal(f.opens, 2);
  assert.equal(f.closes, 2);
});
test("new peers authenticate trust capability without changing the native invitation", async () => {
  const f = await fixture();
  const result = await f.run();
  assert.deepEqual(result.features, ["trust-v1"]);
  assert.deepEqual(JSON.parse(result.invitation), f.info);
  assert.equal(f.opens, 1);
  assert.equal(f.closes, 1);
});
test("an invalid v2 proof fails without retrying the legacy protocol", async () => {
  const f = await fixture({ tamper: true });
  await assert.rejects(f.run());
  assert.equal(f.opens, 1);
  assert.equal(f.closes, 1);
});
test("cancellation never opens another connection", async () => {
  const f = await fixture({ cancelled: () => true });
  await assert.rejects(f.run(), /cancelled/);
  assert.equal(f.opens, 0);
  assert.equal(f.closes, 1);
});
