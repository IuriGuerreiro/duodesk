import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionRecovery } from "../src/stream/recovery.ts";

function setup(t, sender = true) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  let attempts = 0;
  let exhausted = 0;
  const recovery = new ConnectionRecovery({
    changed: (state) => states.push(state),
    exhausted: () => exhausted++,
    ...(sender ? { restart: () => attempts++ } : {}),
  });
  return {
    recovery,
    states,
    get attempts() {
      return attempts;
    },
    get exhausted() {
      return exhausted;
    },
  };
}

test("brief interruption recovers without renegotiation", (t) => {
  const s = setup(t);
  s.recovery.interrupt();
  assert.equal(s.states.at(-1).state, "interrupted");
  t.mock.timers.tick(2_999);
  s.recovery.connected();
  t.mock.timers.tick(30_000);
  assert.equal(s.attempts, 0);
  assert.equal(s.exhausted, 0);
});

test("two attempts and backoff exhaust the budget without resetting on duplicate events", (t) => {
  const s = setup(t);
  s.recovery.interrupt();
  t.mock.timers.tick(3_000);
  assert.equal(s.attempts, 1);
  s.recovery.interrupt();
  s.recovery.reconnect();
  assert.equal(s.attempts, 1);
  t.mock.timers.tick(8_000);
  assert.equal(s.states.at(-1).canReconnect, true);
  t.mock.timers.tick(1_999);
  assert.equal(s.attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(s.attempts, 2);
  t.mock.timers.tick(8_000);
  assert.equal(s.exhausted, 1);
  t.mock.timers.tick(30_000);
  s.recovery.reconnect();
  assert.equal(s.exhausted, 1);
  assert.equal(s.attempts, 2);
});

test("manual reconnect spends the same budget", (t) => {
  const s = setup(t);
  s.recovery.interrupt();
  s.recovery.reconnect();
  t.mock.timers.tick(8_000);
  s.recovery.reconnect();
  t.mock.timers.tick(8_000);
  assert.equal(s.attempts, 2);
  assert.equal(s.exhausted, 1);
});

for (const delay of [0, 3_000, 11_000, 13_000]) {
  test(`Stop at ${delay}ms cancels recovery permanently`, (t) => {
    const s = setup(t);
    s.recovery.interrupt();
    if (delay) t.mock.timers.tick(delay);
    s.recovery.close();
    const attempts = s.attempts;
    t.mock.timers.tick(60_000);
    s.recovery.interrupt();
    s.recovery.reconnect();
    assert.equal(s.attempts, attempts);
    assert.equal(s.exhausted, 0);
  });
}

test("receiver waits at most 25 seconds and never creates an offer", (t) => {
  const s = setup(t, false);
  s.recovery.interrupt();
  assert.equal(s.states.at(-1).canReconnect, false);
  t.mock.timers.tick(24_999);
  s.recovery.reconnect();
  assert.equal(s.exhausted, 0);
  t.mock.timers.tick(1);
  assert.equal(s.exhausted, 1);
  assert.equal(s.attempts, 0);
});
