import test from "node:test";
import assert from "node:assert/strict";
import {
  baseSize,
  clampViewport,
  frameFor,
  initialViewport,
  MAX_ZOOM,
  pan,
  pinch,
  toggleMode,
} from "../src/features/stream-viewer/viewport.ts";
import { startViewerSession } from "../src/features/stream-viewer/viewer-lifecycle.ts";

const phone = { width: 800, height: 360 }; // 20:9 landscape
const desktop = { width: 1920, height: 1080 };

test("fit shows the whole desktop without distortion", () => {
  const f = frameFor(initialViewport("fit"), phone, desktop);
  assert.equal(f.height, 360);
  assert.equal(f.width, 640);
  assert.equal(f.left, 80);
  assert.equal(f.top, 0);
});

test("fill covers the screen and crops", () => {
  const b = baseSize(phone, desktop, "fill");
  assert.equal(b.width, 800);
  assert.equal(b.height, 450);
});

test("unknown video size falls back to the container", () => {
  assert.deepEqual(baseSize(phone, { width: 0, height: 0 }, "fit"), phone);
});

test("zoom and pan stay bounded", () => {
  const v = clampViewport(
    { mode: "fit", zoom: 99, offset: { x: 1e6, y: -1e6 } },
    phone,
    desktop,
  );
  assert.equal(v.zoom, MAX_ZOOM);
  assert.equal(v.offset.x, (640 * 4 - 800) / 2);
  assert.equal(v.offset.y, -(360 * 4 - 360) / 2);
  assert.deepEqual(
    pan(initialViewport("fit"), phone, desktop, { x: 50, y: 50 }).offset,
    { x: 0, y: 0 },
  );
});

test("pinch zooms around the fingers", () => {
  const v = pinch(initialViewport("fit"), phone, desktop, {
    startDistance: 100,
    distance: 200,
    startCenter: { x: 600, y: 180 },
    center: { x: 600, y: 180 },
  });
  assert.equal(v.zoom, 2);
  assert.equal(v.offset.x, -200); // content under x=600 stays under the fingers
});

test("rotation re-clamps an old pan", () => {
  const zoomed = { mode: "fit", zoom: 2, offset: { x: 240, y: 180 } };
  const portrait = { width: 360, height: 800 };
  const v = clampViewport(zoomed, portrait, desktop);
  assert.ok(Math.abs(v.offset.x) <= (360 * 2 - 360) / 2);
  assert.equal(v.offset.y, 0);
});

test("toggling mode resets zoom", () => {
  assert.deepEqual(
    toggleMode({ mode: "fit", zoom: 3, offset: { x: 5, y: 5 } }),
    initialViewport("fill"),
  );
});

function fakePlatform(over = {}) {
  const calls = [];
  return {
    calls,
    platform: {
      supported: true,
      enterViewerMode: async () => calls.push("enter"),
      exitViewerMode: async () => calls.push("exit"),
      subscribeViewer: () => (
        calls.push("subscribe"),
        { remove: () => calls.push("unsubscribe") }
      ),
      watch: async () => calls.push("watch"),
      stopWatching: async () => calls.push("stop"),
      ...over,
    },
  };
}
const noop = { onStatus() {}, onError() {} };

test("session enters landscape and restores on close once", async () => {
  const { calls, platform } = fakePlatform();
  const close = startViewerSession(platform, "inv", noop);
  close();
  close();
  await Promise.resolve();
  assert.deepEqual(calls, [
    "subscribe",
    "enter",
    "watch",
    "unsubscribe",
    "stop",
    "exit",
  ]);
});

test("watch failure reports and still restores on close", async () => {
  const errors = [];
  const { calls, platform } = fakePlatform({
    watch: async () => {
      throw new Error("boom");
    },
  });
  const close = startViewerSession(platform, "inv", {
    ...noop,
    onError: (m) => errors.push(m),
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ["boom"]);
  close();
  assert.ok(calls.includes("exit"));
});

test("unsupported platforms never touch orientation", () => {
  const { calls, platform } = fakePlatform({ supported: false });
  startViewerSession(platform, undefined, noop)();
  assert.ok(
    !calls.includes("enter") &&
      !calls.includes("exit") &&
      !calls.includes("watch"),
  );
});
