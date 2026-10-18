import test from "node:test";
import assert from "node:assert/strict";
import { createScanGate } from "../src/features/pairing/scan-gate.ts";
import { connectToDesktop } from "../src/features/pairing/connect-flow.ts";
import {
  createPairingClient,
  createPairingQrPayload,
  createPairingServer,
  parsePairingQrPayload,
} from "../../../packages/protocol/src/pairing.ts";

const address = "192.168.1.20:39871";
const qr = createPairingQrPayload(address, "012345");
const armed = () => {
  const gate = createScanGate(parsePairingQrPayload);
  gate.open();
  return gate;
};

test("a valid QR yields one pairing request however often the camera repeats it", () => {
  const gate = armed();
  assert.deepEqual(gate.accept(qr), {
    kind: "pairing",
    address,
    code: "012345",
  });
  for (let frame = 0; frame < 30; frame += 1) {
    assert.equal(gate.accept(qr).kind, "ignored");
  }
});

test("a closed scanner ignores events that arrive late", () => {
  const gate = createScanGate(parsePairingQrPayload);
  assert.equal(gate.accept(qr).kind, "ignored");
  gate.open();
  gate.close();
  assert.equal(gate.accept(qr).kind, "ignored");
});

test("reopening the scanner arms it again for a new code", () => {
  const gate = armed();
  assert.equal(gate.accept(qr).kind, "pairing");
  gate.open();
  const next = createPairingQrPayload(address, "999999");
  assert.deepEqual(gate.accept(next), {
    kind: "pairing",
    address,
    code: "999999",
  });
});

test("unusable QR codes are reported once and do not stop the scan", () => {
  const gate = armed();
  const bad = [
    "https://example.com/",
    JSON.stringify({ v: 1, token: "x" }),
    `duodesk-pair://connect?v=1&address=8.8.8.8%3A39871&code=012345`,
    `${qr}&extra=1`,
    "duodesk-pair://connect?v=1&address=192.168.1.20%3A39871&code=12345",
  ];
  for (const text of bad) {
    const first = gate.accept(text);
    assert.equal(first.kind, "invalid", text);
    assert.match(first.message, /DuoDesk pairing QR/);
    assert.equal(gate.accept(text).kind, "ignored", "repeat of the same frame");
  }
  assert.equal(gate.accept(qr).kind, "pairing");
});

function recorder(overrides = {}) {
  const calls = [];
  const flow = {
    requestLocalNetwork: async () => void calls.push("permission"),
    pair: async (a, c) => {
      calls.push(`pair ${a} ${c}`);
      return "invitation";
    },
    connect: async (invitation) => void calls.push(`connect ${invitation}`),
    ...overrides,
  };
  const request = (extra = {}) => ({
    address,
    code: "012345",
    cancelled: () => false,
    onPaired: () => calls.push("paired"),
    ...extra,
  });
  return { calls, flow, request };
}

test("a scanned code asks permission, verifies, then connects without another tap", async () => {
  const { calls, flow, request } = recorder();
  const gate = armed();
  const scan = gate.accept(qr);
  assert.equal(scan.kind, "pairing");
  await connectToDesktop(flow, request({ code: scan.code }));
  assert.deepEqual(calls, [
    "permission",
    `pair ${address} 012345`,
    "paired",
    "connect invitation",
  ]);
});

test("a denied permission stops before any network traffic", async () => {
  const { calls, flow, request } = recorder({
    requestLocalNetwork: async () => {
      throw new Error("Allow local network access to connect to your PC.");
    },
  });
  await assert.rejects(connectToDesktop(flow, request()), /local network/);
  assert.deepEqual(calls, []);
});

test("cancelling while the permission prompt is open never pairs", async () => {
  let cancelled = false;
  const { calls, flow, request } = recorder({
    requestLocalNetwork: async () => {
      cancelled = true;
    },
  });
  await connectToDesktop(flow, request({ cancelled: () => cancelled }));
  assert.deepEqual(calls, []);
});

test("cancelling during verification never connects the stale invitation", async () => {
  let cancelled = false;
  const { calls, flow, request } = recorder({
    pair: async () => {
      cancelled = true;
      return "stale";
    },
  });
  await connectToDesktop(flow, request({ cancelled: () => cancelled }));
  assert.deepEqual(calls, ["permission"]);
});

test("a rejected code leaves the sender untouched and a new code can be tried", async () => {
  let attempts = 0;
  const { calls, flow, request } = recorder({
    pair: async (a, c) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Code verification failed.");
      calls.push(`pair ${a} ${c}`);
      return "invitation";
    },
  });
  await assert.rejects(connectToDesktop(flow, request()), /verification/);
  assert.deepEqual(
    calls.filter((c) => c !== "permission"),
    [],
  );
  await connectToDesktop(flow, request({ code: "654321" }));
  assert.deepEqual(calls.slice(-3), [
    `pair ${address} 654321`,
    "paired",
    "connect invitation",
  ]);
});

test("a sender failure after pairing is reported to the caller", async () => {
  const { flow, request } = recorder({
    connect: async () => {
      throw new Error("Cannot reach the desktop.");
    },
  });
  await assert.rejects(connectToDesktop(flow, request()), /Cannot reach/);
});

// Real SRP on both sides; only the TCP hop is replaced by a function call.
function lan(serve, invitation) {
  const request = `scan-${Math.random()}`;
  return async (a, code) => {
    const client = createPairingClient(code, a);
    const challenge = await serve(request, client.hello, invitation);
    const proof = await client.challenge(challenge.message);
    const verified = await serve(request, proof, invitation);
    return client.finish(verified.message);
  };
}
const invitation = (expiresAt = Date.now() + 120000) => ({
  v: 1,
  sessionId: "a".repeat(32),
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  url: "wss://192.168.1.20:12345/",
  expiresAt,
});

test("scanning the desktop's real QR delivers its invitation to the sender", async () => {
  const info = invitation();
  const serve = await createPairingServer("012345");
  const sent = [];
  const { flow, request } = recorder({
    pair: lan(serve, info),
    connect: async (i) => void sent.push(i),
  });
  const scan = armed().accept(createPairingQrPayload(address, "012345"));
  await connectToDesktop(flow, request({ code: scan.code }));
  assert.deepEqual(
    sent.map((s) => JSON.parse(s)),
    [info],
  );
});

test("an expired or already used QR fails cleanly instead of connecting", async () => {
  const sent = [];
  const connect = async (i) => void sent.push(i);
  const expired = await createPairingServer("012345");
  await assert.rejects(
    connectToDesktop(
      recorder({ pair: lan(expired, invitation(Date.now() - 1)), connect })
        .flow,
      { address, code: "012345", cancelled: () => false, onPaired() {} },
    ),
  );
  const once = await createPairingServer("012345");
  const info = invitation();
  const flow = recorder({ pair: lan(once, info), connect }).flow;
  const run = () =>
    connectToDesktop(flow, {
      address,
      code: "012345",
      cancelled: () => false,
      onPaired() {},
    });
  await run();
  await assert.rejects(run());
  assert.equal(sent.length, 1);
});
