import { test } from "node:test";
import assert from "node:assert/strict";
import { RESULT_TIMEOUT_MS } from "@duodesk/protocol";
import {
  ControlLink,
  SETTLE_MS,
} from "../src/features/remote-control/control-link.ts";
import {
  EDGE_BAND,
  LINE_PX,
  MAX_SCROLL_MS,
  MAX_TRAVEL,
  MIN_SCROLL_MS,
  STALE_MS,
  WheelScroller,
  wheelPixels,
  wheelSwipe,
} from "../src/features/remote-control/wheel.ts";

const sessionId = "b".repeat(32);
const geometry = { width: 1080, height: 2400, rotation: 0 };
const video = { width: 1080, height: 2400 };
const picture = { width: 360, height: 800 };
const wheel = (deltaY, more = {}) => ({
  deltaX: 0,
  deltaY,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  ...more,
});

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();

function setup() {
  const channels = {};
  const peer = {
    createDataChannel(label, init) {
      return (channels[label] = {
        readyState: "open",
        bufferedAmount: 0,
        sent: [],
        ...init,
        send(text) {
          this.sent.push(JSON.parse(text));
        },
        close() {},
      });
    },
  };
  let now = 10_000;
  const link = new ControlLink(peer, sessionId, () => now);
  const scroller = new WheelScroller(link, () => now);
  const phone = (message) =>
    channels["duodesk-control"].onmessage({
      data: JSON.stringify({ v: 1, sessionId, ...message }),
    });
  const on = (epoch = 1) =>
    phone({ type: "status", epoch, state: "on", geometry });
  const sent = () => channels["duodesk-input"].sent;
  const answer = (seq) =>
    phone({ type: "result", epoch: link.currentEpoch(), seq, status: "done" });
  const advance = (ms) => {
    now += ms;
    link.check();
  };
  on();
  advance(SETTLE_MS + 1);
  return { link, scroller, on, sent, answer, advance, phone };
}

test("wheel deltas are normalised from pixels, lines and pages", () => {
  assert.deepEqual(wheelPixels(wheel(30), picture), { dx: 0, dy: 30 });
  assert.deepEqual(wheelPixels(wheel(3, { deltaMode: 1 }), picture), {
    dx: 0,
    dy: 3 * LINE_PX,
  });
  assert.deepEqual(wheelPixels(wheel(1, { deltaMode: 2 }), picture), {
    dx: 0,
    dy: 800,
  });
});

test("shift turns a vertical wheel sideways only when there is no horizontal delta", () => {
  assert.deepEqual(wheelPixels(wheel(40, { shiftKey: true }), picture), {
    dx: 40,
    dy: 0,
  });
  assert.deepEqual(
    wheelPixels(wheel(40, { shiftKey: true, deltaX: 10 }), picture),
    { dx: 10, dy: 40 },
  );
});

test("ctrl+wheel (pinch) and empty or broken deltas are not scrolls", () => {
  assert.equal(wheelPixels(wheel(40, { ctrlKey: true }), picture), undefined);
  assert.equal(wheelPixels(wheel(0), picture), undefined);
  assert.equal(wheelPixels(wheel(Number.NaN), picture), undefined);
});

test("wheel down moves the finger up from the pointer; right moves it left", () => {
  const down = wheelSwipe([0.5, 0.5], 0, 80, picture);
  assert.deepEqual(down.points[0], [0.5, 0.5]);
  assert.ok(Math.abs(down.points[1][1] - 0.4) < 1e-9);
  assert.equal(down.points[1][0], 0.5);
  const right = wheelSwipe([0.5, 0.5], 36, 0, picture);
  assert.ok(Math.abs(right.points[1][0] - 0.4) < 1e-9);
});

test("travel is capped, the end clamped off the edge and the start never moved", () => {
  const big = wheelSwipe([0.5, 0.5], 0, 10_000, picture);
  assert.ok(Math.abs(big.points[1][1] - (0.5 - MAX_TRAVEL)) < 1e-9);
  assert.equal(big.durationMs, MAX_SCROLL_MS);
  const nearTop = wheelSwipe([0.5, 0.1], 0, 10_000, picture);
  assert.deepEqual(nearTop.points[0], [0.5, 0.1]);
  assert.equal(nearTop.points[1][1], EDGE_BAND);
  const small = wheelSwipe([0.5, 0.5], 0, 8, picture);
  assert.ok(
    small.durationMs >= MIN_SCROLL_MS && small.durationMs < MAX_SCROLL_MS,
  );
});

test("the edge band and tiny movements send nothing", () => {
  assert.equal(wheelSwipe([0.5, 0.01], 0, 80, picture), undefined);
  assert.equal(wheelSwipe([0.99, 0.5], 0, 80, picture), undefined);
  assert.equal(wheelSwipe([0.5, 0.5], 0, 1, picture), undefined);
});

test("a wheel turn sends one swipe through the link's normal gates", () => {
  const { scroller, sent } = setup();
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].type, "swipe");
  assert.equal(sent()[0].epoch, 1);
  assert.deepEqual(sent()[0].points[0], [0.5, 0.5]);
  assert.ok(sent()[0].points[1][1] < 0.5);
});

test("while busy, wheel collects at most one swipe and sends it on completion", () => {
  const { scroller, sent, answer } = setup();
  scroller.wheel(wheel(10), [0.5, 0.5], picture, video);
  for (let i = 0; i < 50; i++)
    scroller.wheel(wheel(100), [0.5, 0.5], picture, video);
  assert.equal(sent().length, 1);
  assert.ok(scroller.waiting);
  answer(sent()[0].seq);
  assert.equal(sent().length, 2);
  const [start, end] = sent()[1].points;
  assert.ok(Math.abs(start[1] - end[1] - MAX_TRAVEL) < 1e-9);
  assert.equal(scroller.waiting, false);
  // Nothing left over after the capped swipe.
  answer(sent()[1].seq);
  assert.equal(sent().length, 2);
});

test("collected scroll that went stale while busy is dropped", () => {
  const { scroller, sent, answer, advance } = setup();
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  advance(STALE_MS + 1);
  answer(sent()[0].seq);
  assert.equal(sent().length, 1);
  assert.equal(scroller.waiting, false);
});

test("an unanswered swipe times out without sending the stale scroll behind it", () => {
  const { scroller, sent, advance, on } = setup();
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  on(1); // heartbeat
  advance(RESULT_TIMEOUT_MS + 1);
  assert.equal(sent().length, 1);
  assert.equal(scroller.waiting, false);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  assert.equal(sent().length, 2);
});

test("an epoch change clears collected scroll", () => {
  const { scroller, sent, on, advance } = setup();
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  on(2);
  assert.equal(scroller.waiting, false);
  advance(SETTLE_MS + 1);
  assert.equal(sent().length, 1);
});

test("reversing direction or moving the pointer starts over", () => {
  const { scroller, sent, answer } = setup();
  scroller.wheel(wheel(10), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(-40), [0.5, 0.5], picture, video);
  answer(sent()[0].seq);
  assert.ok(sent()[1].points[1][1] > 0.5);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.3, 0.3], picture, video);
  answer(sent()[1].seq);
  assert.deepEqual(sent()[2].points[0], [0.3, 0.3]);
});

test("clear and close discard collected scroll; paused or refused input is not retried", () => {
  const { link, scroller, sent, answer } = setup();
  scroller.wheel(wheel(10), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.clear();
  answer(sent()[0].seq);
  assert.equal(sent().length, 1);
  link.setPaused(true);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  assert.equal(sent().length, 1);
  assert.equal(scroller.waiting, false);
  link.setPaused(false);
  scroller.close();
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  scroller.wheel(wheel(80), [0.5, 0.5], picture, video);
  assert.equal(sent().length, 2);
});
