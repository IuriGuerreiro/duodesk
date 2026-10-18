import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvitation, parseSignal } from "../src/index.ts";
const sessionId = "a".repeat(32);
const invitation = {
  v: 1,
  sessionId,
  url: "wss://192.168.1.4:47777/",
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  expiresAt: 200_000,
};
test("accept a bounded invitation and reject expiry or extra fields", () => {
  assert.deepEqual(
    parseInvitation(JSON.stringify(invitation), 100_000),
    invitation,
  );
  assert.throws(() => parseInvitation(JSON.stringify(invitation), 200_000));
  assert.throws(() =>
    parseInvitation(JSON.stringify({ ...invitation, extra: true }), 100_000),
  );
  assert.throws(() =>
    parseInvitation(
      JSON.stringify({ ...invitation, url: "ws://192.168.1.4:1234/" }),
      100_000,
    ),
  );
});
test("validate session identity, message shape and candidate bounds", () => {
  const offer = { v: 1, sessionId, type: "offer", sdp: "v=0\r\n" };
  assert.deepEqual(parseSignal(JSON.stringify(offer), sessionId), offer);
  assert.throws(() => parseSignal(JSON.stringify(offer), "d".repeat(32)));
  assert.throws(() =>
    parseSignal(JSON.stringify({ ...offer, token: "leak" }), sessionId),
  );
  assert.throws(() =>
    parseSignal(
      JSON.stringify({
        v: 1,
        sessionId,
        type: "candidate",
        candidate: "a",
        sdpMid: null,
        sdpMLineIndex: -1,
      }),
      sessionId,
    ),
  );
  assert.throws(() =>
    parseSignal(
      JSON.stringify({ ...offer, sdp: "x".repeat(70_000) }),
      sessionId,
    ),
  );
});
