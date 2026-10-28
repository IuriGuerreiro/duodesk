import { gatherIce } from "../../shared/session/ice-gathering.ts";
import {
  ConnectionRecovery,
  DEFAULT_STREAM_SETTINGS,
  fitCapture,
  parseSignal,
  type RecoveryStatus,
  type Signal,
  type StreamSettings,
} from "@duodesk/protocol";

/** What the user asked for next to what capture actually delivers; `width`/`height`/`fps` are measured. */
export interface ScreenStats {
  requested: StreamSettings;
  /** The capture size and frame-rate cap the browser applied, or `undefined` if it did not report them. */
  capture?: { width: number; height: number; frameRate?: number };
  codec: string;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  qualityLimit: string;
}

function diagnostic(event: string, data: object = {}) {
  console.info("[screen-debug] " + JSON.stringify({ event, ...data }));
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
  private connected = false;
  private restarting = false;
  private negotiation = new AbortController();
  private initialTimeout?: ReturnType<typeof setTimeout>;
  private recovery: ConnectionRecovery;
  private connectionChanged: () => void;
  private stream?: MediaStream;
  private capture?: ScreenStats["capture"];
  private settings: StreamSettings;
  private previous?: { bytes: number; timestamp: number };
  private sessionId: string;
  private send: (signal: Signal) => Promise<void>;
  private onError: (message: string) => void;

  constructor(
    sessionId: string,
    send: (signal: Signal) => Promise<void>,
    onError: (message: string) => void,
    onConnection: (state: RTCPeerConnectionState) => void,
    settings: StreamSettings = DEFAULT_STREAM_SETTINGS,
    onRecovery: (status: RecoveryStatus) => void = () => {},
  ) {
    this.settings = settings;
    this.sessionId = sessionId;
    this.send = send;
    this.onError = onError;
    this.peer = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    this.recovery = new ConnectionRecovery({
      changed: onRecovery,
      exhausted: () =>
        this.fail(new Error("Connection could not be recovered. Pair again.")),
      restart: () => void this.restart().catch((error) => this.fail(error)),
    });
    this.peer.onicecandidate = (event) => {
      if (!event.candidate || this.closed || this.restarting) return;
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
    this.peer.onsignalingstatechange = () =>
      diagnostic("signaling-state", { state: this.peer.signalingState });
    this.peer.onicecandidateerror = (event) =>
      diagnostic("ice-error", { code: event.errorCode, text: event.errorText });
    this.connectionChanged = () => {
      if (this.closed) return;
      const ice = this.peer.iceConnectionState;
      const state =
        ice === "disconnected" || ice === "failed"
          ? ice
          : this.restarting && ice !== "connected" && ice !== "completed"
            ? "connecting"
            : this.peer.connectionState;
      diagnostic("connection-state", { state });
      if (state === "connected" && this.answered) {
        clearTimeout(this.initialTimeout);
        this.connected = true;
        this.recovery.connected();
        onConnection("connected");
      } else if (state === "failed" || state === "disconnected") {
        onConnection(state);
        if (this.connected) this.recovery.interrupt();
        else
          this.fail(
            new Error(
              "Phone unreachable. Check Wi-Fi and firewall, then pair again.",
            ),
          );
      }
    };
    this.peer.onconnectionstatechange = this.connectionChanged;
    this.peer.oniceconnectionstatechange = this.connectionChanged;
  }

  /** Starts capture for the paired desktop share session. */
  async start() {
    if (this.started) throw new Error("Screen sharing already started.");
    this.started = true;
    diagnostic("capture-start", {
      secureContext: globalThis.isSecureContext,
      displayMediaAvailable: !!navigator.mediaDevices?.getDisplayMedia,
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: this.settings.frameRate } },
        audio: false,
      });
    } catch (error) {
      diagnostic("capture-error", {
        name: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
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
    diagnostic("capture-track", {
      settings: track.getSettings(),
      state: track.readyState,
      muted: track.muted,
    });
    await this.fit(track);
    if (this.closed) return;
    track.onmute = () => diagnostic("track-muted");
    track.onunmute = () => diagnostic("track-unmuted");
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
      encoding.maxFramerate = this.settings.frameRate;
    });
    // Let the encoder trade some resolution for motion instead of freezing under load.
    parameters.degradationPreference = "balanced";
    await transceiver.sender.setParameters(parameters);
    diagnostic("encoder-configured");
    this.initialTimeout = setTimeout(
      () =>
        this.fail(
          new Error(
            "Phone unreachable. Check Wi-Fi and firewall, then pair again.",
          ),
        ),
      20_000,
    );
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

  reconnect() {
    this.recovery.reconnect();
  }

  private async restart() {
    if (this.closed) return;
    if (this.peer.signalingState !== "stable")
      throw new Error(
        "The peer did not answer recovery. Pair again, and update both apps if needed.",
      );
    this.restarting = true;
    this.answered = false;
    this.pending = [];
    this.negotiation.abort();
    this.negotiation = new AbortController();
    const signal = this.negotiation.signal;
    const offer = await this.peer.createOffer({ iceRestart: true });
    if (signal.aborted) return;
    await this.peer.setLocalDescription(offer);
    await gatherIce(this.peer, signal);
    if (signal.aborted || this.closed) return;
    await this.emit({
      v: 1,
      sessionId: this.sessionId,
      type: "offer",
      sdp: this.peer.localDescription?.sdp ?? "",
    });
  }

  /**
   * Scales the capture into the chosen box at the display's own aspect ratio. Chromium reports the display's
   * size only after capture starts, so the box is applied here rather than in the capture request.
   */
  private async fit(track: MediaStreamTrack) {
    const native = track.getSettings();
    if (!native.width || !native.height) {
      this.capture = undefined;
      diagnostic("capture-size-unknown");
      return;
    }
    const target = fitCapture(native.width, native.height, this.settings);
    const refused = await track
      .applyConstraints({
        width: { max: target.width },
        height: { max: target.height },
        frameRate: { max: this.settings.frameRate },
      })
      .then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    if (refused !== undefined) {
      this.stream?.getTracks().forEach((each) => each.stop());
      throw new Error(
        `This screen could not be captured at ${target.width} × ${target.height} and ${this.settings.frameRate} fps: ${refused}. Choose a smaller size or frame rate.`,
      );
    }
    const applied = track.getSettings();
    this.capture = {
      width: applied.width ?? target.width,
      height: applied.height ?? target.height,
      frameRate: applied.frameRate,
    };
    diagnostic("capture-fit", { native, target, applied });
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
        diagnostic("signal-received", { type: message.type });
        if (message.type === "answer") {
          if (this.answered) throw new Error("Unexpected second video answer.");
          if (
            this.restarting &&
            this.peer.signalingState !== "have-local-offer"
          )
            throw new Error("Unexpected recovery answer. Pair again.");
          this.answered = true;
          await this.peer.setRemoteDescription({
            type: "answer",
            sdp: message.sdp,
          });
          if (this.closed) return;
          for (const candidate of this.pending)
            await this.peer.addIceCandidate(candidate);
          this.pending = [];
          this.connectionChanged();
        } else if (message.type === "candidate") {
          if (this.restarting) return;
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
        requested: this.settings,
        capture: this.capture,
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
    diagnostic("stats", {
      ...stats,
      connection: this.peer.connectionState,
      ice: this.peer.iceConnectionState,
    });
    report.forEach((entry) => {
      if (entry.type === "outbound-rtp" && entry.kind === "video")
        diagnostic("encoder", {
          framesEncoded: entry.framesEncoded,
          framesSent: entry.framesSent,
          bytesSent: entry.bytesSent,
          encoder: entry.encoderImplementation,
          qualityLimit: entry.qualityLimitationReason,
        });
      if (
        entry.type === "candidate-pair" &&
        entry.state === "succeeded" &&
        entry.nominated
      )
        diagnostic("transport", {
          nominated: entry.nominated,
          bytesSent: entry.bytesSent,
          bytesReceived: entry.bytesReceived,
          rtt: entry.currentRoundTripTime,
        });
    });
    return stats;
  }

  stop() {
    if (this.closed) return;
    diagnostic("stop");
    this.closed = true;
    clearTimeout(this.initialTimeout);
    this.recovery.close();
    this.negotiation.abort();
    this.pending = [];
    this.peer.oniceconnectionstatechange = null;
    this.peer.onsignalingstatechange = null;
    this.peer.onicecandidateerror = null;
    this.peer.onicecandidate = null;
    this.peer.onconnectionstatechange = null;
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.onmute = null;
      track.onunmute = null;
      track.stop();
    });
    this.peer.close();
  }

  private fail(error: unknown) {
    if (this.closed) return;
    diagnostic("failure", {
      message: error instanceof Error ? error.message : String(error),
    });
    this.stop();
    this.onError(
      error instanceof Error ? error.message : "Screen session failed.",
    );
  }
}
