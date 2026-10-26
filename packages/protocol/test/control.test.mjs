import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containedContent,
  encodeInputCommand,
  normalizeTypedText,
  parseControlCaps,
  validTypedText,
  parseCommandResult,
  parseControlStatus,
  parseInputCommand,
  parseNavCapabilities,
  toNormalized,
  toPixel,
  videoMatchesDisplay,
} from "../src/index.ts";

const sessionId = "a".repeat(32);
const base = { v: 1, sessionId };
const json = JSON.stringify;
const geometry = { width: 1080, height: 2400, rotation: 0 };

test("accept well-formed phone status and reject anything off-shape", () => {
  const on = { ...base, type: "status", epoch: 3, state: "on", geometry };
  assert.deepEqual(parseControlStatus(json(on), sessionId), on);
  const off = {
    ...base,
    type: "status",
    epoch: 4,
    state: "off",
    reason: "revoked",
  };
  assert.deepEqual(parseControlStatus(json(off), sessionId), off);

  const bad = [
    { ...on, geometry: { ...geometry, rotation: 4 } },
    { ...on, geometry: { ...geometry, width: 0 } },
    { ...on, geometry: { ...geometry, width: 99_999 } },
    { ...on, geometry: { ...geometry, extra: 1 } },
    { ...on, reason: "revoked" },
    { ...off, geometry },
    { ...off, reason: "because" },
    { ...off, epoch: -1 },
    { ...off, epoch: 1.5 },
    { ...off, extra: true },
    { ...off, sessionId: "b".repeat(32) },
    { ...off, v: 2 },
  ];
  for (const message of bad)
    assert.throws(
      () => parseControlStatus(json(message), sessionId),
      JSON.stringify(message),
    );
  assert.throws(() => parseControlStatus("not json", sessionId));
  assert.throws(() =>
    parseControlStatus(json({ ...off, pad: "x".repeat(3000) }), sessionId),
  );
});

test("command results carry a reason only when rejected", () => {
  const result = { ...base, type: "result", epoch: 2, seq: 7 };
  for (const status of ["done", "cancelled", "failed"])
    assert.equal(
      parseCommandResult(json({ ...result, status }), sessionId).status,
      status,
    );
  assert.equal(
    parseCommandResult(
      json({ ...result, status: "rejected", reason: "stale" }),
      sessionId,
    ).status,
    "rejected",
  );
  assert.throws(() =>
    parseCommandResult(json({ ...result, status: "rejected" }), sessionId),
  );
  assert.throws(() =>
    parseCommandResult(
      json({ ...result, status: "done", reason: "stale" }),
      sessionId,
    ),
  );
  assert.throws(() =>
    parseCommandResult(
      json({ ...result, status: "rejected", reason: "nope" }),
      sessionId,
    ),
  );
  assert.throws(() =>
    parseCommandResult(json({ ...result, seq: 0, status: "done" }), sessionId),
  );
});

test("accept taps and swipes and round-trip the encoder", () => {
  const tap = { ...base, type: "tap", epoch: 1, seq: 1, x: 0, y: 1 };
  assert.deepEqual(parseInputCommand(encodeInputCommand(tap), sessionId), tap);
  const swipe = {
    ...base,
    type: "swipe",
    epoch: 1,
    seq: 2,
    durationMs: 300,
    points: [
      [0.5, 0.8],
      [0.5, 0.2],
    ],
  };
  assert.deepEqual(
    parseInputCommand(encodeInputCommand(swipe), sessionId),
    swipe,
  );
});

test("reject malformed, out-of-range and over-long commands", () => {
  const tap = { ...base, type: "tap", epoch: 1, seq: 1, x: 0.5, y: 0.5 };
  const swipe = {
    ...base,
    type: "swipe",
    epoch: 1,
    seq: 2,
    durationMs: 300,
    points: [
      [0.1, 0.1],
      [0.9, 0.9],
    ],
  };
  const manyPoints = Array.from({ length: 33 }, (_, i) => [i / 40, 0.5]);
  const bad = [
    { ...tap, x: 1.0001 },
    { ...tap, y: -0.1 },
    { ...tap, x: "0.5" },
    { ...tap, x: null },
    { ...tap, seq: 0 },
    { ...tap, seq: 2 ** 31 },
    { ...tap, epoch: -1 },
    { ...tap, extra: 1 },
    { ...tap, sessionId: "c".repeat(32) },
    { ...tap, type: "key" },
    { ...swipe, durationMs: 49 },
    { ...swipe, durationMs: 2001 },
    { ...swipe, durationMs: 100.5 },
    { ...swipe, points: [[0.1, 0.1]] },
    { ...swipe, points: manyPoints },
    { ...swipe, points: [[0.1, 0.1], [0.2]] },
    {
      ...swipe,
      points: [
        [0.1, 0.1],
        [0.2, 1.2],
      ],
    },
    { ...swipe, points: "none" },
    { ...swipe, x: 0.5 },
  ];
  for (const message of bad)
    assert.throws(
      () => parseInputCommand(json(message), sessionId),
      json(message),
    );
  assert.doesNotThrow(() =>
    parseInputCommand(
      json({ ...swipe, points: manyPoints.slice(0, 32) }),
      sessionId,
    ),
  );
  // JSON cannot carry NaN or Infinity; they would serialise to null and fail above.
  assert.throws(() =>
    parseInputCommand(json({ ...tap, x: Number.NaN }), sessionId),
  );
});

test("content rectangle excludes letterbox and pillarbox margins", () => {
  // Portrait phone in a wide window: pillarboxed.
  const wide = containedContent(1600, 900, 1080, 2400);
  assert.ok(wide);
  assert.ok(Math.abs(wide.height - 900) < 1e-9);
  assert.ok(Math.abs(wide.width - 405) < 1e-9);
  assert.ok(Math.abs(wide.left - 597.5) < 1e-9);
  assert.equal(wide.top, 0);
  // Landscape phone in a tall window: letterboxed.
  const tall = containedContent(800, 1000, 2400, 1080);
  assert.ok(tall);
  assert.equal(tall.left, 0);
  assert.ok(Math.abs(tall.width - 800) < 1e-9);
  assert.ok(Math.abs(tall.height - 360) < 1e-9);
  assert.ok(Math.abs(tall.top - 320) < 1e-9);
  assert.equal(containedContent(800, 600, 0, 0), undefined);
  assert.equal(containedContent(0, 600, 100, 100), undefined);
});

test("pointer positions map to the picture, never to the margins", () => {
  const content = containedContent(1600, 900, 1080, 2400);
  assert.ok(content);
  assert.deepEqual(toNormalized(content.left, content.top, content), [0, 0]);
  const centre = toNormalized(
    content.left + content.width / 2,
    content.top + content.height / 2,
    content,
  );
  assert.ok(centre);
  assert.ok(
    Math.abs(centre[0] - 0.5) < 1e-9 && Math.abs(centre[1] - 0.5) < 1e-9,
  );
  // In the black margin: clamped for drags, refused for taps.
  assert.deepEqual(toNormalized(10, 450, content), [0, 0.5]);
  assert.equal(toNormalized(10, 450, content, false), undefined);
  assert.equal(
    toNormalized(0, 0, { left: 0, top: 0, width: 0, height: 10 }),
    undefined,
  );
});

test("normalized coordinates become display pixels inside the display", () => {
  assert.equal(toPixel(0, 1080), 0);
  assert.equal(toPixel(1, 1080), 1079);
  assert.equal(toPixel(0.5, 1081), 540);
  assert.equal(toPixel(2, 100), 99);
  assert.equal(toPixel(-1, 100), 0);
});

test("video must have the shape of the reported display", () => {
  assert.equal(videoMatchesDisplay(geometry, 1080, 2400), true);
  assert.equal(videoMatchesDisplay(geometry, 1080, 2398), true);
  // Encoder rounding to even sizes is fine; a rotated frame is not.
  assert.equal(videoMatchesDisplay(geometry, 2400, 1080), false);
  assert.equal(
    videoMatchesDisplay(
      { ...geometry, width: 2400, height: 1080, rotation: 1 },
      1080,
      2400,
    ),
    false,
  );
  assert.equal(videoMatchesDisplay(geometry, 0, 0), false);
});

test("navigation commands carry exactly one known action", () => {
  const nav = {
    v: 1,
    sessionId,
    type: "nav",
    epoch: 2,
    seq: 3,
    action: "back",
  };
  for (const action of ["back", "home", "recents"])
    assert.deepEqual(
      parseInputCommand(encodeInputCommand({ ...nav, action }), sessionId),
      { ...nav, action },
    );
  for (const bad of [
    { ...nav, action: "power" },
    { ...nav, action: "BACK" },
    { ...nav, action: 1 },
    { ...nav, action: undefined },
    { ...nav, x: 0.5 },
    { ...nav, seq: 0 },
    { ...nav, v: 2 },
  ])
    assert.throws(() => parseInputCommand(JSON.stringify(bad), sessionId));
});

test("navigation capabilities list each known action at most once", () => {
  const caps = {
    v: 1,
    sessionId,
    type: "nav-caps",
    epoch: 1,
    actions: ["back", "recents"],
  };
  assert.deepEqual(parseNavCapabilities(JSON.stringify(caps), sessionId), caps);
  assert.deepEqual(
    parseNavCapabilities(JSON.stringify({ ...caps, actions: [] }), sessionId)
      .actions,
    [],
  );
  for (const bad of [
    { ...caps, actions: ["back", "back"] },
    { ...caps, actions: ["power"] },
    { ...caps, actions: "back" },
    { ...caps, extra: true },
    { ...caps, type: "status" },
    { ...caps, sessionId: "b".repeat(32) },
  ])
    assert.throws(() => parseNavCapabilities(JSON.stringify(bad), sessionId));
  // A desktop that predates capabilities reads them as a status, and refuses them.
  assert.throws(() => parseControlStatus(JSON.stringify(caps), sessionId));
});

test("caps are a separate message and accept only a boolean text flag", () => {
  const caps = { ...base, type: "caps", epoch: 3, text: true };
  assert.deepEqual(parseControlCaps(json(caps), sessionId), caps);
  for (const message of [
    { ...caps, text: "yes" },
    { ...caps, extra: 1 },
    { ...caps, epoch: -1 },
    { ...caps, type: "status" },
  ])
    assert.throws(() => parseControlCaps(json(message), sessionId));
  // An older desktop reads anything that is not a result as a status, and drops caps.
  assert.throws(() => parseControlStatus(json(caps), sessionId));
});

test("text and key commands are validated strictly", () => {
  const command = { ...base, epoch: 1, seq: 2 };
  for (const text of [
    "a",
    "héllo\tworld\nline",
    "👍🏽 family 👨‍👩‍👧",
    "مرحبا",
    "x".repeat(500),
  ])
    assert.equal(
      parseInputCommand(json({ ...command, type: "text", text }), sessionId)
        .text,
      text,
    );
  for (const text of [
    "",
    "x".repeat(501),
    "a\rb",
    "\u0000",
    "\u001b[A",
    "\u007f",
    "\u0085",
    "\ud83d",
    "a\ude00b",
    5,
  ])
    assert.throws(
      () =>
        parseInputCommand(json({ ...command, type: "text", text }), sessionId),
      JSON.stringify(text),
    );
  assert.throws(() =>
    parseInputCommand(
      json({ ...command, type: "text", text: "a", extra: 1 }),
      sessionId,
    ),
  );
  for (const key of ["backspace", "delete", "enter"])
    assert.equal(
      parseInputCommand(json({ ...command, type: "key", key }), sessionId).key,
      key,
    );
  for (const key of ["escape", "Enter", 13])
    assert.throws(() =>
      parseInputCommand(json({ ...command, type: "key", key }), sessionId),
    );
});

test("text helpers normalize line endings and keep commands under the size limit", () => {
  assert.equal(normalizeTypedText("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(validTypedText("👍"), true);
  assert.equal(validTypedText("👍".slice(0, 1)), false);
  // The worst case for 500 units: every character needs three UTF-8 bytes.
  const wide = encodeInputCommand({
    ...base,
    epoch: 2_147_483_647,
    seq: 2_147_483_647,
    type: "text",
    text: "€".repeat(500),
  });
  assert.ok(new TextEncoder().encode(wide).length <= 2048);
  assert.throws(() =>
    encodeInputCommand({
      ...base,
      epoch: 1,
      seq: 1,
      type: "text",
      text: "€".repeat(700),
    }),
  );
  assert.equal(
    parseCommandResult(
      json({
        ...base,
        type: "result",
        epoch: 1,
        seq: 1,
        status: "rejected",
        reason: "nofield",
      }),
      sessionId,
    ).reason,
    "nofield",
  );
});
