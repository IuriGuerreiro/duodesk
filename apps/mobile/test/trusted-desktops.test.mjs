import test from "node:test";
import assert from "node:assert/strict";
import {
  createReconnectFlow,
  reconnectReducer,
  reconnectFailure,
  retryDelay,
} from "../src/features/trusted-desktops/reconnect.ts";
import { hasTrustedDevices } from "../modules/test-video/trust-capability.ts";
import { connectToDesktop } from "../src/features/pairing/connect-flow.ts";

const fingerprint = "c".repeat(64);
const networkError = () =>
  Object.assign(new Error("Offline"), { code: "ERR_TRUST_NETWORK" });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function recorder(overrides = {}) {
  const states = [],
    delays = [],
    invitations = [];
  let attempts = 0,
    closes = 0;
  const flow = createReconnectFlow({
    request: async () => {
      attempts++;
      throw networkError();
    },
    connect: async (invitation) => {
      invitations.push(invitation);
    },
    close: async () => {
      closes++;
    },
    onState: (state) => states.push(state),
    delay: async (ms) => {
      delays.push(ms);
    },
    ...overrides,
  });
  return {
    flow,
    states,
    delays,
    invitations,
    attempts: () => attempts,
    closes: () => closes,
  };
}

test("transient reconnect failures retry exactly after 1, 2 and 4 seconds, then stop", async () => {
  const r = recorder();
  await r.flow.run(fingerprint);
  assert.equal(r.attempts(), 4);
  assert.deepEqual(r.delays, [1000, 2000, 4000]);
  assert.deepEqual(r.invitations, []);
  assert.equal(r.states.at(-1).kind, "failed");
  assert.equal(r.states.at(-1).terminal, false);
});

test("a successful retry connects exactly one ordinary invitation and never starts capture", async () => {
  let attempts = 0;
  const r = recorder({
    request: async () => {
      if (++attempts < 3) throw networkError();
      return "ordinary-v1-invitation";
    },
  });
  await r.flow.run(fingerprint);
  assert.deepEqual(r.delays, [1000, 2000]);
  assert.deepEqual(r.invitations, ["ordinary-v1-invitation"]);
  assert.equal(r.states.at(-1).kind, "connected");
});

for (const code of [
  "ERR_TRUST_AUTH",
  "ERR_TRUST_STORAGE",
  "ERR_TRUST_CANCELLED",
  "ERR_TRUST_PIN",
  undefined,
]) {
  test(`${code ?? "unknown failure"} stops retries immediately`, async () => {
    const r = recorder({
      request: async () => {
        throw Object.assign(new Error("Rejected"), { code });
      },
    });
    await r.flow.run(fingerprint);
    assert.deepEqual(r.delays, []);
    assert.deepEqual(r.invitations, []);
    assert.equal(r.states.length, 2);
    assert.equal(r.states.at(-1).terminal, true);
  });
}

test("cancel closes the transport and ignores an invitation delivered after cancellation", async () => {
  const response = deferred();
  const r = recorder({ request: () => response.promise });
  const run = r.flow.run(fingerprint);
  await r.flow.cancel();
  response.resolve("stale");
  await run;
  assert.equal(r.closes(), 1);
  assert.deepEqual(r.invitations, []);
  assert.equal(r.states.at(-1).kind, "cancelled");
});

test("cancel interrupts a retry timer without waiting or making another request", async () => {
  const sleeping = deferred();
  const r = recorder({
    delay: async (ms, signal) => {
      sleeping.resolve();
      await retryDelay(ms, signal);
    },
  });
  const run = r.flow.run(fingerprint);
  await sleeping.promise;
  await r.flow.cancel();
  await run;
  assert.equal(r.attempts(), 1);
  assert.equal(r.states.at(-1).kind, "cancelled");
});

test("cancelled generation cannot connect over a newer reconnect request", async () => {
  const old = deferred(),
    next = deferred();
  let requests = 0;
  const r = recorder({
    request: () => (++requests === 1 ? old.promise : next.promise),
  });
  const first = r.flow.run(fingerprint);
  await r.flow.cancel();
  const second = r.flow.run("d".repeat(64));
  old.resolve("stale");
  await first;
  next.resolve("current");
  await second;
  assert.deepEqual(r.invitations, ["current"]);
  assert.equal(r.states.at(-1).fingerprint, "d".repeat(64));
});

test("duplicate reconnect taps do not open parallel transports", async () => {
  const response = deferred();
  let attempts = 0;
  const r = recorder({
    request: () => {
      attempts++;
      return response.promise;
    },
  });
  const first = r.flow.run(fingerprint);
  await r.flow.run(fingerprint);
  response.resolve("once");
  await first;
  assert.equal(attempts, 1);
  assert.deepEqual(r.invitations, ["once"]);
});

test("a terminal failure can be retried only by a new explicit user request", async () => {
  let requests = 0;
  const r = recorder({
    request: async () => {
      if (++requests === 1) throw new Error("Revoked");
      return "paired-again";
    },
  });
  await r.flow.run(fingerprint);
  assert.equal(requests, 1);
  await r.flow.run(fingerprint);
  assert.equal(requests, 2);
  assert.deepEqual(r.invitations, ["paired-again"]);
});

test("terminal and cancelled reducer states ignore late retry or success events", () => {
  for (const state of [
    { kind: "cancelled", fingerprint },
    {
      kind: "failed",
      fingerprint,
      attempt: 0,
      terminal: true,
      message: "Revoked",
    },
  ]) {
    assert.equal(reconnectReducer(state, { kind: "retry" }), state);
    assert.equal(reconnectReducer(state, { kind: "connected" }), state);
  }
  assert.equal(
    reconnectFailure({ code: "ERR_TRUST_NETWORK" }).kind,
    "transient",
  );
  assert.equal(
    reconnectFailure(new Error("Identity changed")).kind,
    "terminal",
  );
});

const modern = {
  supportsTrustedDevices: true,
  connectAndRemember() {},
  trustedDesktops() {},
  trustedAddress() {},
  trustedForget() {},
  trustedReconnect() {},
  trustedCancel() {},
};
test("trust requires Android and every native method; old binary, web and iOS hide trust UI", () => {
  assert.equal(hasTrustedDevices("android", modern), true);
  assert.equal(hasTrustedDevices("android", null), false);
  assert.equal(hasTrustedDevices("android", {}), false);
  assert.equal(
    hasTrustedDevices("android", { ...modern, trustedCancel: undefined }),
    false,
  );
  assert.equal(
    hasTrustedDevices("android", { ...modern, supportsTrustedDevices: false }),
    false,
  );
  assert.equal(hasTrustedDevices("ios", modern), false);
  assert.equal(hasTrustedDevices("web", modern), false);
});

test("manual and QR pairing only enroll when the phone explicitly opts in", async () => {
  const calls = [];
  const base = {
    requestLocalNetwork: async () => {},
    pair: async () => "invitation",
    connect: async () => calls.push("ordinary"),
    connectRemembered: async () => calls.push("enroll"),
  };
  const request = {
    address: "192.168.1.20:39871",
    code: "012345",
    cancelled: () => false,
    onPaired() {},
  };
  await connectToDesktop(base, request);
  await connectToDesktop(base, { ...request, remember: false });
  await connectToDesktop(base, { ...request, remember: true });
  assert.deepEqual(calls, ["ordinary", "ordinary", "enroll"]);
});

test("an old native binary still uses v1 pairing when enrollment is unavailable", async () => {
  let connected = false;
  await connectToDesktop(
    {
      requestLocalNetwork: async () => {},
      pair: async () => "v1",
      connect: async () => {
        connected = true;
      },
    },
    {
      address: "192.168.1.20:39871",
      code: "012345",
      remember: true,
      cancelled: () => false,
      onPaired() {},
    },
  );
  assert.equal(connected, true);
});

test("an interrupted enrollment rejects visibly instead of reporting saved success", async () => {
  let saved = false;
  const confirmation = deferred();
  const result = connectToDesktop(
    {
      requestLocalNetwork: async () => {},
      pair: async () => "v1",
      connect: async () => {},
      connectRemembered: async () => {
        await confirmation.promise;
        throw new Error("Not confirmed");
      },
    },
    {
      address: "192.168.1.20:39871",
      code: "012345",
      remember: true,
      cancelled: () => false,
      onPaired() {},
    },
  ).then(() => {
    saved = true;
  });
  confirmation.resolve();
  await assert.rejects(result, /Not confirmed/);
  assert.equal(saved, false);
});
