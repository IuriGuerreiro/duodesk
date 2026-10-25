import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControlLink,
  SETTLE_MS,
} from "../src/features/remote-control/control-link.ts";
import {
  GestureRecorder,
  TAP_MAX_MS,
  simplify,
} from "../src/features/remote-control/gesture.ts";
import { navBlocked, navSummary } from "../src/features/remote-control/copy.ts";

const sessionId = "a".repeat(32);
const geometry = { width: 1080, height: 2400, rotation: 0 };
const video = { width: 1080, height: 2400 };

class FakeChannel {
  readyState = "open";
  bufferedAmount = 0;
  sent = [];
  constructor(init) {
    Object.assign(this, init);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = "closed";
  }
}

// Each link polls on a timer. Keep it from holding the test process open.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();

function setup() {
  const channels = {};
  const peer = {
    createDataChannel(label, init) {
      return (channels[label] = new FakeChannel({ label, ...init }));
    },
  };
  let now = 10_000;
  const link = new ControlLink(peer, sessionId, () => now);
  const views = [];
  link.subscribe(() => views.push(link.getView()));
  const phone = (message) =>
    channels["duodesk-control"].onmessage({
      data: JSON.stringify({ v: 1, sessionId, ...message }),
    });
  const on = (epoch = 1, geo = geometry) =>
    phone({ type: "status", epoch, state: "on", geometry: geo });
  const off = (epoch, reason = "revoked") =>
    phone({ type: "status", epoch, state: "off", reason });
  return {
    link,
    channels,
    input: channels["duodesk-input"],
    phone,
    on,
    off,
    views,
    advance(ms) {
      now += ms;
      link.check();
    },
    settled() {
      this.advance(SETTLE_MS + 1);
    },
  };
}

test("opens two negotiated channels, the input one short-lived", () => {
  const { channels } = setup();
  assert.equal(channels["duodesk-control"].id, 1);
  assert.equal(channels["duodesk-control"].negotiated, true);
  assert.equal(channels["duodesk-control"].maxPacketLifeTime, undefined);
  assert.equal(channels["duodesk-input"].id, 2);
  assert.equal(channels["duodesk-input"].negotiated, true);
  assert.equal(channels["duodesk-input"].maxPacketLifeTime, 500);
});

test("control stays unavailable until the phone says it is on", () => {
  const t = setup();
  assert.equal(t.link.getView().phase, "waiting");
  assert.equal(t.link.tap([0.5, 0.5], 1, video), false);
  t.off(1, "service-disabled");
  assert.equal(t.link.getView().phase, "off");
  assert.equal(t.link.getView().reason, "service-disabled");
  assert.equal(t.link.tap([0.5, 0.5], 1, video), false);
  assert.equal(t.input.sent.length, 0);
});

test("sends a tap for the phone's current epoch once the picture has settled", () => {
  const t = setup();
  t.on(3);
  assert.equal(t.link.getView().phase, "syncing");
  assert.equal(
    t.link.tap([0.2, 0.7], 3, video),
    false,
    "too soon after a change",
  );
  t.settled();
  assert.equal(t.link.getView().phase, "active");
  assert.equal(t.link.tap([0.2, 0.7], 3, video), true);
  assert.deepEqual(t.input.sent[0], {
    v: 1,
    sessionId,
    epoch: 3,
    seq: 1,
    type: "tap",
    x: 0.2,
    y: 0.7,
  });
});

test("never queues: one command in flight, the next waits for the phone's answer", () => {
  const t = setup();
  t.on(1);
  t.settled();
  assert.equal(t.link.tap([0.5, 0.5], 1, video), true);
  assert.equal(t.link.getView().busy, true);
  assert.equal(t.link.tap([0.6, 0.6], 1, video), false);
  assert.equal(
    t.link.swipe(
      [
        [0.1, 0.1],
        [0.9, 0.9],
      ],
      300,
      1,
      video,
    ),
    false,
  );
  t.phone({ type: "result", epoch: 1, seq: 1, status: "done" });
  assert.equal(t.link.getView().busy, false);
  assert.equal(
    t.link.swipe(
      [
        [0.1, 0.1],
        [0.9, 0.9],
      ],
      300,
      1,
      video,
    ),
    true,
  );
  assert.equal(t.input.sent.length, 2);
  assert.equal(t.input.sent[1].seq, 2);
  assert.equal(t.input.sent[1].type, "swipe");
});

test("an unanswered command is forgotten, not retried", () => {
  const t = setup();
  t.on(1);
  t.settled();
  t.link.tap([0.5, 0.5], 1, video);
  t.advance(3600);
  assert.equal(t.link.getView().busy, false);
  assert.equal(t.input.sent.length, 1);
});

test("a gesture that started in an older epoch is dropped, not remapped", () => {
  const t = setup();
  t.on(1);
  t.settled();
  t.on(2, { width: 2400, height: 1080, rotation: 1 });
  t.settled();
  assert.equal(t.link.tap([0.5, 0.5], 1, { width: 2400, height: 1080 }), false);
  assert.equal(t.link.tap([0.5, 0.5], 2, { width: 2400, height: 1080 }), true);
  assert.equal(t.input.sent[0].epoch, 2);
});

test("a picture of the wrong shape blocks input until the frames catch up", () => {
  const t = setup();
  t.on(1);
  t.settled();
  const sideways = { width: 2400, height: 1080 };
  assert.equal(t.link.blocker(sideways), "syncing");
  assert.equal(t.link.tap([0.5, 0.5], 1, sideways), false);
  assert.equal(t.link.blocker(video), undefined);
});

test("revocation stops input immediately and ignores older status", () => {
  const t = setup();
  t.on(4);
  t.settled();
  t.off(5, "revoked");
  assert.equal(t.link.getView().phase, "off");
  assert.equal(t.link.tap([0.5, 0.5], 4, video), false);
  // A late copy of the earlier "on" status must not turn control back on.
  t.on(4);
  assert.equal(t.link.getView().phase, "off");
  assert.equal(t.input.sent.length, 0);
});

test("local pause stops sending without telling the phone anything", () => {
  const t = setup();
  t.on(1);
  t.settled();
  t.link.setPaused(true);
  assert.equal(t.link.getView().phase, "paused");
  assert.equal(t.link.tap([0.5, 0.5], 1, video), false);
  t.link.setPaused(false);
  assert.equal(t.link.getView().phase, "active");
  assert.equal(t.link.tap([0.5, 0.5], 1, video), true);
});

test("a silent phone, a closed channel or a lost link turns control off", () => {
  const silent = setup();
  silent.on(1);
  silent.settled();
  silent.advance(4100);
  assert.equal(silent.link.getView().phase, "waiting");
  assert.equal(silent.link.tap([0.5, 0.5], 1, video), false);

  const closed = setup();
  closed.on(1);
  closed.settled();
  closed.input.readyState = "closed";
  assert.equal(closed.link.tap([0.5, 0.5], 1, video), false);
  closed.channels["duodesk-control"].onclose();
  assert.equal(closed.link.getView().phase, "waiting");
});

test("a phone that restarts control at a lower epoch is accepted after a gap", () => {
  const t = setup();
  t.on(7);
  t.advance(4100);
  t.on(1);
  assert.equal(t.link.getView().phase, "syncing");
});

test("malformed or foreign phone messages change nothing", () => {
  const t = setup();
  t.on(1);
  t.settled();
  const before = t.views.length;
  const raw = t.channels["duodesk-control"];
  raw.onmessage({ data: "garbage" });
  raw.onmessage({ data: new ArrayBuffer(4) });
  raw.onmessage({
    data: JSON.stringify({
      v: 1,
      sessionId: "b".repeat(32),
      type: "status",
      epoch: 9,
      state: "off",
      reason: "revoked",
    }),
  });
  raw.onmessage({
    data: JSON.stringify({
      v: 1,
      sessionId,
      type: "status",
      epoch: 9,
      state: "on",
    }),
  });
  assert.equal(t.views.length, before);
  assert.equal(t.link.getView().phase, "active");
});

test("closing ends the link and its channels for good", () => {
  const t = setup();
  t.on(1);
  t.settled();
  t.link.close();
  assert.equal(t.link.getView().phase, "waiting");
  assert.equal(t.input.readyState, "closed");
  assert.equal(t.link.tap([0.5, 0.5], 1, video), false);
  assert.equal(t.input.sent.length, 0);
});

test("a congested channel drops input instead of queueing it", () => {
  const t = setup();
  t.on(1);
  t.settled();
  t.input.bufferedAmount = 100_000;
  assert.equal(t.link.tap([0.5, 0.5], 1, video), false);
});

test("a quick click is a tap at the press position", () => {
  const r = new GestureRecorder();
  r.begin([0.3, 0.4], 100, 100, 0);
  r.move([0.31, 0.41], 103, 102);
  assert.deepEqual(r.end([0.31, 0.41], 103, 102, 120), {
    kind: "tap",
    point: [0.3, 0.4],
  });
});

test("a long stationary press is ignored rather than guessed at", () => {
  const r = new GestureRecorder();
  r.begin([0.3, 0.4], 100, 100, 0);
  assert.deepEqual(r.end([0.3, 0.4], 100, 100, TAP_MAX_MS + 1), {
    kind: "ignored",
  });
});

test("a drag becomes a swipe with its path and duration", () => {
  const r = new GestureRecorder();
  r.begin([0.5, 0.8], 200, 400, 1000);
  for (let i = 1; i <= 10; i++)
    r.move([0.5, 0.8 - i * 0.06], 200, 400 - i * 24);
  const gesture = r.end([0.5, 0.2], 200, 160, 1300);
  assert.equal(gesture.kind, "swipe");
  assert.equal(gesture.durationMs, 300);
  assert.deepEqual(gesture.points[0], [0.5, 0.8]);
  assert.ok(Math.abs(gesture.points.at(-1)[1] - 0.2) < 1e-9);
  assert.ok(gesture.points.length >= 2 && gesture.points.length <= 24);
});

test("swipe duration and point count stay within protocol bounds", () => {
  const r = new GestureRecorder();
  r.begin([0, 0], 0, 0, 0);
  for (let i = 1; i <= 500; i++) r.move([i / 500, 0], i * 3, 0);
  const slow = r.end([1, 0], 1500, 0, 20_000);
  assert.equal(slow.kind, "swipe");
  assert.equal(slow.durationMs, 2000);
  assert.ok(slow.points.length <= 24);
  assert.deepEqual(slow.points.at(-1), [1, 0]);
  r.begin([0, 0], 0, 0, 0);
  const fast = r.end([1, 1], 300, 300, 5);
  assert.equal(fast.durationMs, 50);
});

test("a cancelled gesture sends nothing", () => {
  const r = new GestureRecorder();
  r.begin([0.5, 0.5], 10, 10, 0);
  r.cancel();
  assert.equal(r.active, false);
  assert.deepEqual(r.end([0.5, 0.5], 10, 10, 50), { kind: "ignored" });
});

test("simplify keeps both ends and the order", () => {
  const items = Array.from({ length: 101 }, (_, i) => i);
  const out = simplify(items, 11);
  assert.equal(out.length, 11);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 100);
  assert.deepEqual(
    [...out].sort((a, b) => a - b),
    out,
  );
  assert.deepEqual(simplify([1, 2, 3], 5), [1, 2, 3]);
});

const caps = (t, actions = ["back", "home", "recents"], epoch = 1) =>
  t.phone({ type: "nav-caps", epoch, actions });

test("navigation is never sent to a phone that did not advertise it", () => {
  const t = setup();
  t.on(1);
  t.settled();
  assert.equal(t.link.navigate("back"), false, "older phone app");
  assert.match(navBlocked(t.link.getView(), "back"), /Update DuoDesk/);
  caps(t, ["back", "home"]);
  assert.equal(t.link.navigate("recents"), false);
  assert.match(navBlocked(t.link.getView(), "recents"), /isn't available/);
  assert.equal(t.input.sent.length, 0);
});

test("a navigation button sends one command for the current epoch", () => {
  const t = setup();
  t.on(2);
  caps(t, undefined, 2);
  // No coordinates to map, so the settle window does not block it.
  assert.equal(t.link.navigate("home"), true);
  assert.deepEqual(t.input.sent[0], {
    v: 1,
    sessionId,
    epoch: 2,
    seq: 1,
    type: "nav",
    action: "home",
  });
  assert.equal(t.link.getView().lastNav.outcome, "sent");
  assert.equal(
    navBlocked(t.link.getView(), "back"),
    "Waiting for the phone to answer.",
  );
  assert.equal(t.link.navigate("back"), false, "busy");
  assert.equal(t.link.tap([0.5, 0.5], 2, video), false, "busy");
  t.phone({ type: "result", epoch: 2, seq: 1, status: "done" });
  assert.equal(t.link.getView().lastNav.outcome, "done");
  assert.equal(navSummary(t.link.getView()), "Home accepted by the phone.");
  assert.equal(navBlocked(t.link.getView(), "back"), undefined);
});

test("a failed or rejected navigation is reported, never retried", () => {
  const t = setup();
  t.on(1);
  caps(t);
  t.link.navigate("recents");
  t.phone({ type: "result", epoch: 1, seq: 1, status: "failed" });
  assert.equal(t.link.getView().lastNav.outcome, "failed");
  t.link.navigate("back");
  t.phone({
    type: "result",
    epoch: 1,
    seq: 2,
    status: "rejected",
    reason: "busy",
  });
  assert.equal(t.link.getView().lastNav.outcome, "rejected");
  t.link.navigate("home");
  t.advance(3600);
  assert.equal(t.link.getView().lastNav.outcome, "unanswered");
  assert.equal(t.input.sent.length, 3);
});

test("navigation stops with pause, revocation, an epoch change or a lost link", () => {
  const t = setup();
  t.on(1);
  caps(t);
  t.link.setPaused(true);
  assert.equal(t.link.navigate("back"), false);
  assert.match(navBlocked(t.link.getView(), "back"), /paused/);
  t.link.setPaused(false);
  t.link.navigate("back");
  // The grant changed before the answer: the old command is abandoned, not resent.
  t.on(2);
  assert.equal(t.link.getView().lastNav.outcome, "unanswered");
  t.off(3);
  assert.equal(t.link.navigate("back"), false);
  caps(t, ["back"], 2);
  t.on(4);
  assert.deepEqual(
    t.link.getView().navActions,
    ["back", "home", "recents"],
    "older caps ignored",
  );
  t.channels["duodesk-control"].onclose();
  assert.equal(t.link.getView().navActions, undefined);
  assert.equal(t.link.navigate("back"), false);
  assert.equal(t.input.sent.length, 1);
});

test("malformed navigation capabilities change nothing", () => {
  const t = setup();
  t.on(1);
  caps(t, ["back", "power"]);
  caps(t, ["back", "back"]);
  t.phone({ type: "nav-caps", epoch: 1, actions: ["back"], extra: 1 });
  assert.equal(t.link.getView().navActions, undefined);
  // A current phone that reports nothing available is told apart from an older app.
  caps(t, []);
  assert.match(navBlocked(t.link.getView(), "home"), /isn't available/);
});
