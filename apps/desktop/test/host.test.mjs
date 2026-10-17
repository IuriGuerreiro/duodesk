import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../electron/host.mjs";
test("IPC rejects unknown methods and malformed or oversized signals", () => {
  for (const [method, args] of [
    ["execute", {}],
    ["stream_start", { ip: "localhost" }],
    ["stream_stop", {}],
    [
      "stream_send",
      {
        signal: {
          v: 1,
          sessionId: "a".repeat(32),
          type: "answer",
          sdp: "x".repeat(60001),
        },
      },
    ],
    [
      "stream_send",
      {
        signal: { v: 1, sessionId: "a".repeat(32), type: "stop", extra: true },
      },
    ],
  ])
    assert.throws(() => validateCommand(method, args));
  validateCommand("stream_start", { ip: "192.168.1.2" });
  validateCommand("stream_send", {
    signal: { v: 1, sessionId: "a".repeat(32), type: "stop" },
  });
});
test("pairing IPC accepts bounded replies and rejects injection and extra fields", () => {
  const reply = { requestId: "a".repeat(32), message: "{}", complete: false };
  validateCommand("stream_pair_reply", { reply });
  validateCommand("stream_pair_reply", { reply: { ...reply, message: "" } });
  for (const changed of [
    { requestId: "old" },
    { message: "x".repeat(8193) },
    { message: "{}\n{}" },
    { complete: "true" },
    { extra: true },
  ])
    assert.throws(() =>
      validateCommand("stream_pair_reply", { reply: { ...reply, ...changed } }),
    );
});
