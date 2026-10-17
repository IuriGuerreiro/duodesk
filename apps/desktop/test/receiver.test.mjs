import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoReceiver } from "../src/streaming/receiver.ts";

class FakePeer {
  static latest;
  remoteDescription = null;
  candidates = [];
  closed = false;
  calls = [];
  constructor() {
    FakePeer.latest = this;
  }
  addTransceiver() {}
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.calls.push("remote");
  }
  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
    this.calls.push("candidate");
  }
  async createAnswer() {
    return { type: "answer", sdp: "test-answer" };
  }
  async setLocalDescription() {
    this.calls.push("local");
  }
  getReceivers() {
    return [];
  }
  close() {
    this.closed = true;
  }
}
const sessionId = "a".repeat(32);
const message = (payload) => ({ v: 1, sessionId, ...payload });
function setup() {
  globalThis.RTCPeerConnection = FakePeer;
  const sent = [],
    errors = [];
  const receiver = new VideoReceiver(
    sessionId,
    async (signal) => {
      sent.push(signal);
    },
    () => {},
    (error) => errors.push(error),
    () => {},
  );
  return { receiver, peer: FakePeer.latest, sent, errors };
}
test("queues early ICE, answers once, then rejects renegotiation", async () => {
  const { receiver, peer, sent, errors } = setup();
  await receiver.receive(
    message({
      type: "candidate",
      candidate: "test",
      sdpMid: "0",
      sdpMLineIndex: 0,
    }),
  );
  assert.equal(peer.candidates.length, 0);
  await receiver.receive(message({ type: "offer", sdp: "offer" }));
  assert.deepEqual(peer.calls, ["remote", "candidate", "local"]);
  assert.equal(sent[0].type, "answer");
  await receiver.receive(message({ type: "offer", sdp: "second-offer" }));
  assert.equal(peer.closed, true);
  assert.equal(errors.length, 1);
});
test("stopped sessions ignore late signaling and cleanup is repeatable", async () => {
  const { receiver, peer, sent } = setup();
  receiver.stop();
  receiver.stop();
  await receiver.receive(message({ type: "offer", sdp: "late-offer" }));
  assert.equal(peer.closed, true);
  assert.equal(sent.length, 0);
  assert.deepEqual(peer.calls, []);
});
test("stale session closes the peer without processing its SDP", async () => {
  const { receiver, peer, errors } = setup();
  await receiver.receive({
    ...message({ type: "offer", sdp: "offer" }),
    sessionId: "b".repeat(32),
  });
  assert.equal(peer.closed, true);
  assert.equal(errors.length, 1);
  assert.deepEqual(peer.calls, []);
});
