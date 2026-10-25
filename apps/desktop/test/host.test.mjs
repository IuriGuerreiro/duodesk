import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNAL_ROUTES as PROTOCOL_ROUTES } from "@duodesk/protocol";
import { DESKTOP_SENDS, validateCommand } from "../electron/host.mjs";
test("IPC rejects unknown methods and malformed or oversized signals", () => {
  for (const [method, args] of [
    ["execute", {}],
    ["stream_start", { ip: "localhost", direction: "phone-to-desktop" }],
    ["stream_start", { ip: "192.168.1.2" }],
    ["stream_start", { ip: "192.168.1.2", direction: "both" }],
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
    assert.throws(() => validateCommand(method, args, "phone-to-desktop"));
  validateCommand("stream_start", {
    ip: "192.168.1.2",
    direction: "desktop-to-phone",
  });
  validateCommand(
    "stream_send",
    { signal: { v: 1, sessionId: "a".repeat(32), type: "stop" } },
    "phone-to-desktop",
  );
});
test("stream_send only allows the desktop's side of the active direction", () => {
  const signal = (type) => ({
    signal: { v: 1, sessionId: "a".repeat(32), type, sdp: "v=0" },
  });
  validateCommand("stream_send", signal("answer"), "phone-to-desktop");
  validateCommand("stream_send", signal("offer"), "desktop-to-phone");
  assert.throws(() =>
    validateCommand("stream_send", signal("offer"), "phone-to-desktop"),
  );
  assert.throws(() =>
    validateCommand("stream_send", signal("answer"), "desktop-to-phone"),
  );
  assert.throws(() => validateCommand("stream_send", signal("answer")));
});
test("the host route table matches the protocol package", () => {
  for (const [direction, roles] of Object.entries(PROTOCOL_ROUTES))
    assert.deepEqual(
      Object.keys(DESKTOP_SENDS[direction]).sort(),
      [...roles.desktop].sort(),
    );
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
