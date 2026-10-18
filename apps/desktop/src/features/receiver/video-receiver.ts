import { parseSignal, type Signal } from "@duodesk/protocol";

export interface VideoStats {
  codec: string;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  packetsLost: number;
  framesDropped: number;
  decodeMs: number;
}

/** Owns one peer and its negotiation queue. A stopped instance can never reconnect. */
export class VideoReceiver {
  private peer: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private queue = Promise.resolve();
  private closed = false;
  private offered = false;
  private previous?: { bytes: number; timestamp: number };
  private sessionId: string;
  private send: (signal: Signal) => Promise<void>;
  private onError: (message: string) => void;

  constructor(
    sessionId: string,
    send: (signal: Signal) => Promise<void>,
    onVideo: (stream: MediaStream) => void,
    onError: (message: string) => void,
    onConnection: (state: RTCPeerConnectionState) => void,
  ) {
    this.sessionId = sessionId;
    this.send = send;
    this.onError = onError;
    this.peer = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    this.peer.addTransceiver("video", { direction: "recvonly" });
    this.peer.ontrack = (event) => {
      if (!this.closed) onVideo(new MediaStream([event.track]));
    };
    this.peer.onicecandidate = (event) => {
      if (!event.candidate || this.closed) return;
      const candidate = event.candidate;
      void this.send({
        v: 1,
        sessionId,
        type: "candidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
      }).catch((error) => this.fail(error));
    };
    this.peer.onconnectionstatechange = () => {
      if (this.closed) return;
      onConnection(this.peer.connectionState);
      if (
        this.peer.connectionState === "failed" ||
        this.peer.connectionState === "disconnected"
      ) {
        this.fail(
          new Error(
            "Video connection lost. Create a new connection to reconnect.",
          ),
        );
      }
    };
  }

  receive(signal: Signal) {
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        const message = parseSignal(JSON.stringify(signal), {
          sessionId: this.sessionId,
          direction: "phone-to-desktop",
          from: "phone",
        });
        if (message.type === "offer") {
          if (this.offered) throw new Error("Unexpected second video offer.");
          this.offered = true;
          await this.peer.setRemoteDescription({
            type: "offer",
            sdp: message.sdp,
          });
          if (this.closed) return;
          for (const candidate of this.pending)
            await this.peer.addIceCandidate(candidate);
          this.pending = [];
          const answer = await this.peer.createAnswer();
          await this.peer.setLocalDescription(answer);
          if (!this.closed)
            await this.send({
              v: 1,
              sessionId: this.sessionId,
              type: "answer",
              sdp: answer.sdp ?? "",
            });
        } else if (message.type === "candidate") {
          if (this.pending.length >= 128)
            throw new Error("Too many pending candidates.");
          const candidate = {
            candidate: message.candidate,
            sdpMid: message.sdpMid,
            sdpMLineIndex: message.sdpMLineIndex,
          };
          if (this.peer.remoteDescription)
            await this.peer.addIceCandidate(candidate);
          else this.pending.push(candidate);
        } else if (message.type === "stop") this.stop();
        else throw new Error("Unexpected sender message.");
      })
      .catch((error) => this.fail(error));
    return this.queue;
  }

  async stats(): Promise<VideoStats | undefined> {
    if (this.closed) return;
    const report = await this.peer.getStats();
    let stats: VideoStats | undefined;
    report.forEach((entry) => {
      if (entry.type !== "inbound-rtp" || entry.kind !== "video") return;
      const codec = report.get(entry.codecId);
      const previous = this.previous;
      const elapsed = previous ? entry.timestamp - previous.timestamp : 0;
      stats = {
        codec: codec?.mimeType ?? "negotiating",
        width: entry.frameWidth ?? 0,
        height: entry.frameHeight ?? 0,
        fps: entry.framesPerSecond ?? 0,
        mbps:
          elapsed > 0 && previous
            ? Math.max(
                0,
                ((entry.bytesReceived - previous.bytes) * 8) / elapsed / 1000,
              )
            : 0,
        packetsLost: entry.packetsLost ?? 0,
        framesDropped: entry.framesDropped ?? 0,
        decodeMs: entry.framesDecoded
          ? ((entry.totalDecodeTime ?? 0) * 1000) / entry.framesDecoded
          : 0,
      };
      this.previous = {
        bytes: entry.bytesReceived,
        timestamp: entry.timestamp,
      };
    });
    return stats;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.peer.ontrack = null;
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    this.peer.getReceivers().forEach((receiver) => receiver.track?.stop());
    this.peer.close();
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.stop();
    this.onError(
      error instanceof Error ? error.message : "Video session failed.",
    );
  }
}
