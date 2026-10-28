import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitCapture,
  parseStreamSettings,
  validateStreamSettings,
  videoMatchesDisplay,
} from "../src/index.ts";

test("accepts custom values inside the limits", () => {
  assert.deepEqual(parseStreamSettings({ maxLongSide: "1600", maxShortSide: "900", frameRate: "45" }), {
    ok: true,
    settings: { maxLongSide: 1600, maxShortSide: 900, frameRate: 45 },
  });
});

test("rejects out-of-range, fractional, and swapped values with a clear message", () => {
  const bad = [
    [{ maxLongSide: 5000, maxShortSide: 1080, frameRate: 30 }, /Width/],
    [{ maxLongSide: 1920, maxShortSide: 100, frameRate: 30 }, /Height/],
    [{ maxLongSide: 720, maxShortSide: 1280, frameRate: 30 }, /cannot be larger/],
    [{ maxLongSide: 1920, maxShortSide: 1080, frameRate: 120 }, /Frame rate/],
    [{ maxLongSide: 1920, maxShortSide: 1080, frameRate: 2 }, /Frame rate/],
    [{ maxLongSide: 1920.5, maxShortSide: 1080, frameRate: 30 }, /Width/],
  ];
  for (const [input, message] of bad) {
    const result = validateStreamSettings(input);
    assert.equal(result.ok, false);
    assert.match(result.error, message);
  }
  assert.equal(parseStreamSettings({ maxLongSide: "1e3", maxShortSide: "720", frameRate: "30" }).ok, false);
});

test("fits landscape and portrait sources into the oriented box without distortion", () => {
  const box = { maxLongSide: 1280, maxShortSide: 720 };
  assert.deepEqual(fitCapture(2560, 1440, box), { width: 1280, height: 720 });
  assert.deepEqual(fitCapture(1440, 2560, box), { width: 720, height: 1280 });
  // A tall phone is limited by its long side, keeping its 20:9 shape.
  const phone = fitCapture(1080, 2400, box);
  assert.deepEqual(phone, { width: 576, height: 1280 });
  for (const [w, h] of [[1080, 2400], [2400, 1080], [3440, 1440], [1366, 768]]) {
    const fit = fitCapture(w, h, box);
    assert.equal(fit.width % 2, 0);
    assert.equal(fit.height % 2, 0);
    // Remote control accepts the picture as the same display.
    assert.ok(videoMatchesDisplay({ width: w, height: h, rotation: 0 }, fit.width, fit.height));
  }
});

test("never upscales a small source", () => {
  assert.deepEqual(fitCapture(1280, 720, { maxLongSide: 3840, maxShortSide: 2160 }), { width: 1280, height: 720 });
});
