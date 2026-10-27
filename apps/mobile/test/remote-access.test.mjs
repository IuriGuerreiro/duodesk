import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteAccessRequest } from "../src/features/stream-sender/remote-access.ts";

function setup({ enabled = true, status = { state: "ready" } } = {}) {
  const calls = [];
  let current = status;
  let permission = enabled;
  const errors = [];
  const request = new RemoteAccessRequest({
    status: () => current,
    serviceEnabled: async () => permission,
    openSettings: async () => {
      calls.push("settings");
    },
    shareScreen: async () => {
      calls.push("share");
      return true;
    },
    allowControl: async () => {
      calls.push("allow");
    },
    changed: () => {},
    failed: (message) => errors.push(message),
  });
  return {
    request,
    calls,
    errors,
    permission(enabled) {
      permission = enabled;
    },
    status(next) {
      current = next;
      request.statusChanged(next);
    },
  };
}
const streaming = {
  state: "streaming",
  mode: "screen",
  control: { state: "off", reason: "not-allowed", serviceEnabled: true },
};

test("remote access shares first and allows once after the screen session starts", async () => {
  const { request, calls, status } = setup();
  await request.start();
  assert.deepEqual(calls, ["share"]);
  status(streaming);
  status(streaming);
  await Promise.resolve();
  assert.deepEqual(calls, ["share", "allow"]);
});

test("missing accessibility opens settings and continues after enabling it", async () => {
  const { request, calls, permission, status } = setup({ enabled: false });
  await request.start();
  assert.equal(request.waitingForSettings(), true);
  assert.deepEqual(calls, ["settings"]);
  permission(true);
  await request.resume();
  assert.deepEqual(calls, ["settings", "share"]);
  status(streaming);
  await Promise.resolve();
  assert.deepEqual(calls, ["settings", "share", "allow"]);
});

test("returning without accessibility does not share or grant control", async () => {
  const { request, calls } = setup({ enabled: false });
  await request.start();
  await request.resume();
  assert.equal(request.waitingForSettings(), false);
  assert.deepEqual(calls, ["settings"]);
});

test("remote access can enable control on an existing screen stream", async () => {
  const { request, calls } = setup({ status: streaming });
  await request.start();
  assert.deepEqual(calls, ["allow"]);
});

test("disconnect during settings cancels the pending request", async () => {
  const { request, calls, status, permission } = setup({ enabled: false });
  await request.start();
  status({ state: "stopped" });
  permission(true);
  await request.resume();
  status(streaming);
  assert.deepEqual(calls, ["settings"]);
});

test("stopping or choosing view-only before streaming prevents a later grant", async () => {
  const { request, calls, status } = setup();
  await request.start();
  request.cancel();
  status(streaming);
  assert.deepEqual(calls, ["share"]);
});

test("cancellation while checking permission cannot open settings or start sharing", async () => {
  let answer;
  const calls = [];
  const request = new RemoteAccessRequest({
    status: () => ({ state: "ready" }),
    serviceEnabled: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
    openSettings: async () => {
      calls.push("settings");
    },
    shareScreen: async () => {
      calls.push("share");
      return true;
    },
    allowControl: async () => {
      calls.push("allow");
    },
    changed: () => {},
    failed: () => {},
  });
  const pending = request.start();
  request.cancel();
  answer(true);
  await pending;
  assert.deepEqual(calls, []);
});

test("a denied capture request cannot grant control to a later stream", async () => {
  const calls = [];
  const request = new RemoteAccessRequest({
    status: () => ({ state: "ready" }),
    serviceEnabled: async () => true,
    openSettings: async () => {},
    shareScreen: async () => false,
    allowControl: async () => {
      calls.push("allow");
    },
    changed: () => {},
    failed: () => {},
  });
  await request.start();
  request.statusChanged(streaming);
  assert.deepEqual(calls, []);
});

test("remote access waits for the screen size before allowing control", async () => {
  const { request, calls, status } = setup();
  await request.start();
  status({
    ...streaming,
    control: { state: "off", reason: "geometry-unknown", serviceEnabled: true },
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["share"]);
  status(streaming);
  await Promise.resolve();
  assert.deepEqual(calls, ["share", "allow"]);
});

for (const state of ["interrupted", "reconnecting", "disconnected"]) {
  test(`pending remote access is cancelled on ${state}`, async () => {
    const t = setup();
    await t.request.start();
    t.status({ state });
    t.status(streaming);
    await Promise.resolve();
    assert.deepEqual(t.calls, ["share"]);
  });
}
