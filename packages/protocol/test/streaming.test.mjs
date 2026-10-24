import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTIONS,
  SIGNAL_ROUTES,
  canSend,
  parseInvitation,
  parseSignal,
} from "../src/index.ts";
const sessionId = "a".repeat(32);
const invitation = {
  v: 1,
  direction: "phone-to-desktop",
  sessionId,
  url: "wss://192.168.1.4:47777/",
  token: "b".repeat(64),
  fingerprint: "c".repeat(64),
  expiresAt: 200_000,
};
test("accept a bounded invitation and reject expiry or extra fields", () => {
  assert.deepEqual(
    parseInvitation(JSON.stringify(invitation), 100_000),
    invitation,
  );
  assert.throws(() => parseInvitation(JSON.stringify(invitation), 200_000));
  assert.throws(() =>
    parseInvitation(JSON.stringify({ ...invitation, extra: true }), 100_000),
  );
  assert.throws(() =>
    parseInvitation(
      JSON.stringify({ ...invitation, url: "ws://192.168.1.4:1234/" }),
      100_000,
    ),
  );
});
test("invitations carry a known direction and nothing else", () => {
  const flipped = { ...invitation, direction: "desktop-to-phone" };
  assert.deepEqual(parseInvitation(JSON.stringify(flipped), 100_000), flipped);
  const legacy = { ...invitation };
  delete legacy.direction;
  assert.throws(() => parseInvitation(JSON.stringify(legacy), 100_000));
  for (const direction of ["both", "", null, 1])
    assert.throws(() =>
      parseInvitation(JSON.stringify({ ...invitation, direction }), 100_000),
    );
});
test("the route table lets only the offerer send an offer", () => {
  assert.deepEqual(DIRECTIONS, ["phone-to-desktop", "desktop-to-phone"]);
  for (const direction of DIRECTIONS) {
    const offerers = ["desktop", "phone"].filter((from) =>
      canSend(direction, from, "offer"),
    );
    const answerers = ["desktop", "phone"].filter((from) =>
      canSend(direction, from, "answer"),
    );
    assert.equal(offerers.length, 1);
    assert.equal(answerers.length, 1);
    assert.notEqual(offerers[0], answerers[0]);
    for (const from of ["desktop", "phone"]) {
      assert.ok(!canSend(direction, from, "pair"));
      assert.ok(!canSend(direction, from, "paired"));
      assert.ok(canSend(direction, from, "candidate"));
      assert.ok(canSend(direction, from, "stop"));
    }
  }
  assert.ok(canSend("phone-to-desktop", "phone", "offer"));
  assert.ok(canSend("desktop-to-phone", "desktop", "offer"));
  assert.deepEqual(Object.keys(SIGNAL_ROUTES), [...DIRECTIONS]);
});
test("parseSignal rejects types the sender may not use in this direction", () => {
  const offer = JSON.stringify({ v: 1, sessionId, type: "offer", sdp: "v=0" });
  const answer = JSON.stringify({
    v: 1,
    sessionId,
    type: "answer",
    sdp: "v=0",
  });
  const route = (direction, from) => ({ sessionId, direction, from });
  assert.equal(
    parseSignal(offer, route("phone-to-desktop", "phone")).type,
    "offer",
  );
  assert.throws(() => parseSignal(offer, route("phone-to-desktop", "desktop")));
  assert.throws(() => parseSignal(offer, route("desktop-to-phone", "phone")));
  assert.equal(
    parseSignal(answer, route("desktop-to-phone", "phone")).type,
    "answer",
  );
  assert.throws(() =>
    parseSignal(answer, route("desktop-to-phone", "desktop")),
  );
});
test("validate session identity, message shape and candidate bounds", () => {
  const offer = { v: 1, sessionId, type: "offer", sdp: "v=0\r\n" };
  const route = { sessionId, direction: "phone-to-desktop", from: "phone" };
  assert.deepEqual(parseSignal(JSON.stringify(offer), route), offer);
  assert.throws(() =>
    parseSignal(JSON.stringify(offer), { ...route, sessionId: "d".repeat(32) }),
  );
  assert.throws(() =>
    parseSignal(JSON.stringify({ ...offer, token: "leak" }), route),
  );
  assert.throws(() =>
    parseSignal(
      JSON.stringify({
        v: 1,
        sessionId,
        type: "candidate",
        candidate: "a",
        sdpMid: null,
        sdpMLineIndex: -1,
      }),
      route,
    ),
  );
  assert.throws(() =>
    parseSignal(JSON.stringify({ ...offer, sdp: "x".repeat(70_000) }), route),
  );
});

test("only the phone sender can pause without disconnecting", () => {
  const text = JSON.stringify({ v: 1, sessionId, type: "pause" });
  for (const direction of DIRECTIONS)
    for (const from of ["phone", "desktop"]) {
      const route = { sessionId, direction, from };
      if (direction === "phone-to-desktop" && from === "phone")
        assert.equal(parseSignal(text, route).type, "pause");
      else assert.throws(() => parseSignal(text, route));
    }
});
