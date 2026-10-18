import { parseSignal, type Signal } from "@duodesk/protocol";

export interface ScreenStats {
  codec: string;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  qualityLimit: string;
}

const MAX_BITRATE = 8_000_000;
const PREFERRED_CODECS = ["video/h264", "video/vp8"];

/** The phone decodes H.264 in hardware where it can and falls back to VP8, so offer both in that order. */
function preferredCodecs(): RTCRtpCodec[] {
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const rank = (codec: RTCRtpCodec) => {
    const index = PREFERRED_CODECS.indexOf(codec.mimeType.toLowerCase());
    return index < 0 ? PREFERRED_CODECS.length : index;
  };
  return [...codecs].sort((a, b) => rank(a) - rank(b));
}

/** Owns one peer that shares this screen. A stopped instance can never reconnect. */
export class ScreenSender {
  private peer: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private queue = Promise.resolve();
  private outbound = Promise.resolve();
  private closed = false;
  private started = false;
  private answered = false;
  private stream?: MediaStream;
  private previous?: { bytes: number; timestamp: number };
  private sessionId: string;
  private send: (signal: Signal) => Promise<void>;
  private onError: (message: string) => void;

  constructor(
    sessionId: string,
    send: (signal: Signal) => Promise<void>,
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
    this.peer.onicecandidate = (event) => {
      if (!event.candidate || this.closed) return;
      const candidate = event.candidate;
      void this.emit({
        v: 1,
        sessionId,
        type: "candidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
      });
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
            "Screen connection lost. Create a new connection to reconnect.",
          ),
        );
      }
    };
  }

  /** Must run from a user gesture: the browser only shows the capture grant to one. */
  async start() {
    if (this.started) throw new Error("Screen sharing already started.");
    this.started = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error("No screen video was captured.");
    track.contentHint = "detail";
    track.onended = () => this.fail(new Error("Screen sharing was stopped."));
    const transceiver = this.peer.addTransceiver(track, {
      direction: "sendonly",
      streams: [stream],
    });
    transceiver.setCodecPreferences(preferredCodecs());
    const parameters = transceiver.sender.getParameters();
    parameters.encodings.forEach((encoding) => {
      encoding.maxBitrate = MAX_BITRATE;
      encoding.maxFramerate = 30;
    });
    await transceiver.sender.setParameters(parameters);
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    if (!this.closed)
      await this.emit({
        v: 1,
        sessionId: this.sessionId,
        type: "offer",
        sdp: offer.sdp ?? "",
      });
  }

  /** The host rejects bursts of concurrent requests, and the offer must precede its candidates. */
  private emit(signal: Signal) {
    this.outbound = this.outbound
      .then(() => (this.closed ? undefined : this.send(signal)))
      .catch((error) => this.fail(error));
    return this.outbound;
  }

  receive(signal: Signal) {
    this.queue = this.queue
      .then(async () => {
        if (this.closed) return;
        const message = parseSignal(JSON.stringify(signal), {
          sessionId: this.sessionId,
          direction: "desktop-to-phone",
          from: "phone",
        });
        if (message.type === "answer") {
          if (this.answered) throw new Error("Unexpected second video answer.");
          this.answered = true;
          await this.peer.setRemoteDescription({
            type: "answer",
            sdp: message.sdp,
          });
          if (this.closed) return;
          for (const candidate of this.pending)
            await this.peer.addIceCandidate(candidate);
          this.pending = [];
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
        else throw new Error("Unexpected viewer message.");
      })
      .catch((error) => this.fail(error));
    return this.queue;
  }

  async stats(): Promise<ScreenStats | undefined> {
    if (this.closed) return;
    const report = await this.peer.getStats();
    let stats: ScreenStats | undefined;
    report.forEach((entry) => {
      if (entry.type !== "outbound-rtp" || entry.kind !== "video") return;
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
                ((entry.bytesSent - previous.bytes) * 8) / elapsed / 1000,
              )
            : 0,
        qualityLimit: entry.qualityLimitationReason ?? "none",
      };
      this.previous = { bytes: entry.bytesSent, timestamp: entry.timestamp };
    });
    return stats;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.peer.close();
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.stop();
    this.onError(
      error instanceof Error ? error.message : "Screen session failed.",
    );
  }
}
