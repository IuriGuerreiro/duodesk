import test from "node:test";
import assert from "node:assert/strict";
import { createNearbyController } from "../src/features/pairing/nearby-controller.ts";

function fakePlatform(over = {}) {
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    emit: (e) => listeners.forEach((l) => l(e)),
    listeners,
    platform: {
      supported: true,
      hasPermission: async () => true,
      requestPermission: async () => true,
      start: async () => calls.push("start"),
      stop: async () => calls.push("stop"),
      subscribe(l) {
        listeners.add(l);
        return { remove: () => listeners.delete(l) };
      },
      ...over,
    },
  };
}
const found = (instance, host, name = "PC") => ({
  type: "found",
  instance,
  hosts: [host],
  port: 40000,
  txt: { v: "1", role: "desktop", name },
});

test("browses, lists valid devices, ignores junk, handles loss", async () => {
  const f = fakePlatform();
  const c = createNearbyController(f.platform, () => {});
  await c.begin();
  assert.equal(c.state.status, "searching");
  f.emit(found("DuoDesk-0000000a", "192.168.1.5", "Desk"));
  f.emit(found("DuoDesk-0000000a", "192.168.1.5", "Desk"));
  f.emit(found("Printer", "192.168.1.9"));
  f.emit({
    type: "found",
    instance: "DuoDesk-0000000b",
    hosts: ["8.8.8.8"],
    port: 1,
    txt: { v: "1", role: "desktop" },
  });
  assert.deepEqual(
    c.state.devices.map((d) => d.address),
    ["192.168.1.5:40000"],
  );
  f.emit({ type: "lost", instance: "DuoDesk-0000000a" });
  assert.deepEqual(c.state.devices, []);
});

test("never prompts on begin; retry prompts; denial is reported", async () => {
  let asked = 0;
  const f = fakePlatform({
    hasPermission: async () => false,
    requestPermission: async () => (asked++, false),
  });
  const c = createNearbyController(f.platform, () => {});
  await c.begin();
  assert.equal(c.state.status, "needs-permission");
  assert.equal(asked, 0);
  await c.retry();
  assert.equal(c.state.status, "denied");
  assert.equal(asked, 1);
  assert.deepEqual(f.calls, []);
});

test("end stops, clears and ignores late events; restart works", async () => {
  const f = fakePlatform();
  const c = createNearbyController(f.platform, () => {});
  await c.begin();
  const stale = [...f.listeners][0];
  c.end();
  stale(found("DuoDesk-0000000a", "10.0.0.2"));
  assert.equal(c.state.status, "idle");
  assert.deepEqual(c.state.devices, []);
  assert.equal(f.listeners.size, 0);
  await c.begin();
  f.emit(found("DuoDesk-0000000c", "10.0.0.3"));
  assert.equal(c.state.devices.length, 1);
  assert.deepEqual(f.calls, ["start", "stop", "start"]);
});

test("native errors and unsupported platforms surface as states", async () => {
  const f = fakePlatform({
    start: async () => {
      throw new Error("boom");
    },
  });
  const c = createNearbyController(f.platform, () => {});
  await c.begin();
  assert.equal(c.state.status, "error");
  const g = fakePlatform();
  const d = createNearbyController(g.platform, () => {});
  await d.begin();
  g.emit({ type: "state", state: "error", code: 3 });
  assert.equal(d.state.status, "error");
  const u = createNearbyController(
    { ...g.platform, supported: false },
    () => {},
  );
  await u.begin();
  assert.equal(u.state.status, "unsupported");
});
