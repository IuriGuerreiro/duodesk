import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VideoReceiver,
  preferStereoOpus,
} from "../src/features/receiver/video-receiver.ts";

class FakePeer {
  static latest;
  remoteDescription = null;
  candidates = [];
  closed = false;
  calls = [];
  constructor() {
    FakePeer.latest = this;
  }
  transceivers = [];
  createDataChannel(label, init) {
    return { label, ...init, close() {} };
  }
  addTransceiver(kind, init) {
    this.transceivers.push({ kind, init });
  }
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

test("requests receive-only video and audio on one peer", () => {
  const { peer } = setup();
  assert.deepEqual(
    peer.transceivers.map(({ kind, init }) => [kind, init.direction]),
    [
      ["video", "recvonly"],
      ["audio", "recvonly"],
    ],
  );
});
test("tracks from one phone share a single stream", () => {
  globalThis.MediaStream = class {
    tracks = [];
    getTracks() {
      return this.tracks;
    }
    addTrack(track) {
      this.tracks.push(track);
    }
    removeTrack(track) {
      this.tracks = this.tracks.filter((item) => item !== track);
    }
  };
  const streams = [];
  globalThis.RTCPeerConnection = FakePeer;
  new VideoReceiver(
    sessionId,
    async () => {},
    (stream) => streams.push(stream),
    () => {},
    () => {},
  );
  const video = { kind: "video" };
  const audio = { kind: "audio" };
  FakePeer.latest.ontrack({ track: video });
  FakePeer.latest.ontrack({ track: audio });
  FakePeer.latest.ontrack({ track: audio });
  assert.equal(streams[0], streams[1]);
  assert.deepEqual(streams[1].getTracks(), [video, audio]);
  delete globalThis.MediaStream;
});
test("stereo Opus is requested in the answer", () => {
  const rtpmap = "a=rtpmap:111 opus/48000/2";
  assert.equal(
    preferStereoOpus(`${rtpmap}\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n`),
    `${rtpmap}\r\na=fmtp:111 minptime=10;useinbandfec=1;stereo=1\r\n`,
  );
  assert.equal(
    preferStereoOpus(`${rtpmap}\na=fmtp:111 stereo=0;useinbandfec=1\n`),
    `${rtpmap}\na=fmtp:111 useinbandfec=1;stereo=1\n`,
  );
  assert.equal(
    preferStereoOpus(`${rtpmap}\r\na=rtcp-fb:111 transport-cc\r\n`),
    `${rtpmap}\r\na=fmtp:111 stereo=1\r\na=rtcp-fb:111 transport-cc\r\n`,
  );
  const done = `${rtpmap}\r\na=fmtp:111 stereo=1;minptime=10\r\n`;
  assert.equal(preferStereoOpus(done), done);
  const video =
    "m=video 9 UDP/TLS/RTP/SAVPF 102\r\na=fmtp:102 level-asymmetry-allowed=1\r\n";
  assert.equal(preferStereoOpus(video), video);
});
