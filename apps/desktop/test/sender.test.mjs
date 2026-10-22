import { test } from "node:test";
import assert from "node:assert/strict";
import { ScreenSender } from "../src/features/screen-share/screen-sender.ts";

const codecs = [
  { mimeType: "video/VP9" },
  { mimeType: "video/rtx" },
  { mimeType: "video/VP8" },
  { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
  { mimeType: "video/AV1" },
];
class FakeTrack {
  stopped = false;
  onended = null;
  getSettings() {
    return { width: 1920, height: 1080, frameRate: 30 };
  }
  stop() {
    this.stopped = true;
  }
}
class FakePeer {
  static latest;
  remoteDescription = null;
  calls = [];
  candidates = [];
  closed = false;
  parameters = { encodings: [{}] };
  constructor() {
    FakePeer.latest = this;
  }
  addTransceiver(track, init) {
    this.calls.push("transceiver");
    this.track = track;
    this.init = init;
    return {
      setCodecPreferences: (list) => (this.preferences = list),
      sender: {
        getParameters: () => this.parameters,
        setParameters: async (value) => (this.parameters = value),
      },
    };
  }
  async createOffer() {
    this.calls.push("offer");
    return { type: "offer", sdp: "test-offer" };
  }
  async setLocalDescription() {
    this.calls.push("local");
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.calls.push("remote");
  }
  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
    this.calls.push("candidate");
  }
  getSenders() {
    return [];
  }
  close() {
    this.closed = true;
  }
}
const sessionId = "a".repeat(32);
const message = (payload) => ({ v: 1, sessionId, ...payload });
function setup() {
  const track = new FakeTrack();
  const requests = [];
  globalThis.RTCPeerConnection = FakePeer;
  globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs }) };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async (constraints) => {
          requests.push(constraints);
          return { getVideoTracks: () => [track], getTracks: () => [track] };
        },
      },
    },
  });
  const sent = [],
    errors = [];
  const sender = new ScreenSender(
    sessionId,
    async (signal) => {
      sent.push(signal);
    },
    (error) => errors.push(error),
    () => {},
  );
  return { sender, peer: FakePeer.latest, track, requests, sent, errors };
}
test("captures video only, prefers H.264 then VP8, and sends one offer", async () => {
  const { sender, peer, track, requests, sent } = setup();
  await sender.start();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].audio, false);
  assert.equal(peer.track, track);
  assert.equal(peer.init.direction, "sendonly");
  assert.deepEqual(
    peer.preferences.map((codec) => codec.mimeType),
    ["video/H264", "video/VP8", "video/VP9", "video/rtx", "video/AV1"],
  );
  assert.ok(peer.parameters.encodings[0].maxBitrate > 0);
  assert.deepEqual(peer.calls, ["transceiver", "offer", "local"]);
  assert.deepEqual(sent, [message({ type: "offer", sdp: "test-offer" })]);
  await assert.rejects(sender.start(), /already/);
});
test("queues early ICE, accepts one answer, then rejects a second", async () => {
  const { sender, peer, sent, errors } = setup();
  await sender.start();
  await sender.receive(
    message({
      type: "candidate",
      candidate: "early",
      sdpMid: "0",
      sdpMLineIndex: 0,
    }),
  );
  assert.equal(peer.candidates.length, 0);
  await sender.receive(message({ type: "answer", sdp: "answer" }));
  assert.deepEqual(peer.calls.slice(-2), ["remote", "candidate"]);
  assert.equal(sent.length, 1);
  await sender.receive(message({ type: "answer", sdp: "second" }));
  assert.equal(peer.closed, true);
  assert.equal(errors.length, 1);
});
test("a phone offer is outside this direction and fails the session", async () => {
  const { sender, peer, errors } = setup();
  await sender.start();
  await sender.receive(message({ type: "offer", sdp: "offer" }));
  assert.equal(peer.closed, true);
  assert.equal(errors.length, 1);
});
test("stopping releases the capture and ignores late signaling", async () => {
  const { sender, peer, track, sent } = setup();
  await sender.start();
  sender.stop();
  sender.stop();
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
  await sender.receive(message({ type: "answer", sdp: "late" }));
  assert.equal(sent.length, 1);
  assert.equal(peer.remoteDescription, null);
});
test("capture that finishes after stop is released without an offer", async () => {
  const { sender, peer, track, sent } = setup();
  const pending = sender.start();
  sender.stop();
  await pending;
  assert.equal(track.stopped, true);
  assert.equal(sent.length, 0);
  assert.deepEqual(peer.calls, []);
});
test("ending the capture from the system reports an error once", async () => {
  const { sender, peer, track, errors } = setup();
  await sender.start();
  const ended = track.onended;
  ended();
  ended();
  assert.equal(peer.closed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /stopped/);
  sender.stop();
});
test("a denied capture leaves the session ready to try again", async () => {
  const { sender, requests } = setup();
  const original = navigator.mediaDevices.getDisplayMedia;
  navigator.mediaDevices.getDisplayMedia = async () => {
    throw new DOMException("denied", "NotAllowedError");
  };
  await assert.rejects(sender.start(), { name: "NotAllowedError" });
  navigator.mediaDevices.getDisplayMedia = original;
  await sender.start();
  assert.equal(requests.length, 1);
});
