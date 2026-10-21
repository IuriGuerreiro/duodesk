import test from "node:test";
import assert from "node:assert/strict";
import { applyDiscoveryEvent, parseDiscoveryRecord } from "../src/discovery.ts";

const record = (over = {}) => ({
  instance: "DuoDesk-0123abcd",
  hosts: ["192.168.1.20"],
  port: 39871,
  txt: { v: "1", role: "desktop", name: "Office PC", id: "0123abcd" },
  ...over,
});
const found = (over) => ({ type: "found", record: record(over) });

test("accepts a valid desktop record", () => {
  assert.deepEqual(parseDiscoveryRecord(record()), {
    id: "DuoDesk-0123abcd",
    name: "Office PC",
    address: "192.168.1.20:39871",
  });
});

test("rejects untrusted or incompatible records", () => {
  for (const bad of [
    { instance: "Printer" },
    { instance: 5 },
    { port: 0 },
    { port: 70000 },
    { port: "39871" },
    { hosts: ["8.8.8.8"] },
    { hosts: ["fe80::1"] },
    { hosts: "192.168.1.20" },
    { hosts: [] },
    { txt: { v: "2", role: "desktop" } },
    { txt: { v: "1", role: "phone" } },
    { txt: null },
    { txt: ["v=1"] },
  ])
    assert.equal(parseDiscoveryRecord(record(bad)), null, JSON.stringify(bad));
  assert.equal(parseDiscoveryRecord(null), null);
});

test("picks the first private IPv4 among several addresses", () => {
  const d = parseDiscoveryRecord(
    record({ hosts: ["fe80::1", "203.0.113.4", "10.0.0.7"] }),
  );
  assert.equal(d.address, "10.0.0.7:39871");
});

test("sanitizes and bounds the display name", () => {
  const d = parseDiscoveryRecord(
    record({
      txt: { v: "1", role: "desktop", name: "‮Evil\u0007" + "x".repeat(80) },
    }),
  );
  assert.equal(d.name.length, 40);
  assert.ok(d.name.startsWith("Evil"));
  const unnamed = parseDiscoveryRecord(
    record({ txt: { v: "1", role: "desktop" } }),
  );
  assert.equal(unnamed.name, "DuoDesk PC");
});

test("lifecycle: dedupe, replace stale session, remove, invalid update", () => {
  let list = applyDiscoveryEvent([], found());
  list = applyDiscoveryEvent(list, found());
  assert.equal(list.length, 1);
  list = applyDiscoveryEvent(
    list,
    found({
      instance: "DuoDesk-ffffffff",
      hosts: ["192.168.1.30"],
      txt: { v: "1", role: "desktop", name: "Laptop" },
    }),
  );
  assert.deepEqual(
    list.map((d) => d.name),
    ["Laptop", "Office PC"],
  );
  // New pairing code on the same PC: new instance, same endpoint -> replaces old.
  list = applyDiscoveryEvent(list, found({ instance: "DuoDesk-00000001" }));
  assert.deepEqual(list.map((d) => d.id).sort(), [
    "DuoDesk-00000001",
    "DuoDesk-ffffffff",
  ]);
  list = applyDiscoveryEvent(list, {
    type: "lost",
    instance: "DuoDesk-ffffffff",
  });
  assert.deepEqual(
    list.map((d) => d.id),
    ["DuoDesk-00000001"],
  );
  list = applyDiscoveryEvent(
    list,
    found({ instance: "DuoDesk-00000001", hosts: ["1.1.1.1"] }),
  );
  assert.deepEqual(list, []);
  assert.deepEqual(
    applyDiscoveryEvent([], { type: "lost", instance: "nope" }),
    [],
  );
});

test("bounds the list size", () => {
  let list = [];
  for (let i = 0; i < 40; i++)
    list = applyDiscoveryEvent(
      list,
      found({
        instance: `DuoDesk-${i.toString(16).padStart(8, "0")}`,
        hosts: [`10.0.0.${i + 1}`],
      }),
    );
  assert.equal(list.length, 16);
});
