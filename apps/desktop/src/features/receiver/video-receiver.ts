import { parseSignal, type Signal } from "@duodesk/protocol";

export interface AudioStats {
  codec: string;
  kbps: number;
  /** 0–1 loudness of the most recent packets. Zero for a while means silence, not necessarily a fault. */
  level: number;
  packetsLost: number;
  jitterMs: number;
}

export interface VideoStats {
  codec: string;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  packetsLost: number;
  framesDropped: number;
  decodeMs: number;
  /** Present once the phone is sending an audio track. */
  audio?: AudioStats;
}

/**
 * Asks the sender for stereo Opus. A sender picks mono or stereo from the `stereo` parameter in the
 * remote (answer) description, and browsers do not add it on their own.
 */
export function preferStereoOpus(sdp: string): string {
  const type = /^a=rtpmap:(\d+) opus\/48000\/2\r?$/im.exec(sdp)?.[1];
  if (!type) return sdp;
  const prefix = `a=fmtp:${type} `;
  let found = false;
  const lines = sdp.split("\n").map((line) => {
    if (!line.startsWith(prefix)) return line;
    found = true;
    const ending = line.endsWith("\r") ? "\r" : "";
    const all = line
      .slice(prefix.length)
      .replace(/\r$/, "")
      .split(";")
      .map((param) => param.trim());
    if (all.includes("stereo=1")) return line;
    const params = all.filter((param) => param && !param.startsWith("stereo="));
    return `${prefix}${[...params, "stereo=1"].join(";")}${ending}`;
  });
  if (found) return lines.join("\n");
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.startsWith(`a=rtpmap:${type} `))
      out.push(`${prefix}stereo=1${line.endsWith("\r") ? "\r" : ""}`);
  }
  return out.join("\n");
}

/** Owns one peer and its negotiation queue. A stopped instance can never reconnect. */
export class VideoReceiver {
  private peer: RTCPeerConnection;
  private pending: RTCIceCandidateInit[] = [];
  private queue = Promise.resolve();
  private closed = false;
  private offered = false;
  private previous?: { bytes: number; timestamp: number };
  private previousAudio?: { bytes: number; timestamp: number };
  /** One stream for every incoming track, so the player keeps audio and video together. */
  private media?: MediaStream;
  private sessionId: string;
  private send: (signal: Signal) => Promise<void>;
  private onError: (message: string) => void;

  constructor(
    sessionId: string,
    send: (signal: Signal) => Promise<void>,
    onStream: (stream: MediaStream) => void,
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
    // Audio is optional: a phone that cannot or may not share sound answers video-only.
    this.peer.addTransceiver("audio", { direction: "recvonly" });
    this.peer.ontrack = (event) => {
      if (this.closed) return;
      const media = (this.media ??= new MediaStream());
      if (!media.getTracks().includes(event.track)) media.addTrack(event.track);
      onStream(media);
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
          const created = await this.peer.createAnswer();
          const answer = {
            type: "answer" as const,
            sdp: preferStereoOpus(created.sdp ?? ""),
          };
          await this.peer.setLocalDescription(answer);
          if (!this.closed)
            await this.send({
              v: 1,
              sessionId: this.sessionId,
              type: "answer",
              sdp: answer.sdp,
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
    let audio: AudioStats | undefined;
    report.forEach((entry) => {
      if (entry.type !== "inbound-rtp") return;
      const codec = report.get(entry.codecId);
      if (entry.kind === "audio") {
        const previous = this.previousAudio;
        const elapsed = previous ? entry.timestamp - previous.timestamp : 0;
        audio = {
          codec: codec?.mimeType ?? "negotiating",
          kbps:
            elapsed > 0 && previous
              ? Math.max(
                  0,
                  ((entry.bytesReceived - previous.bytes) * 8) / elapsed,
                )
              : 0,
          level: entry.audioLevel ?? 0,
          packetsLost: entry.packetsLost ?? 0,
          jitterMs: (entry.jitter ?? 0) * 1000,
        };
        this.previousAudio = {
          bytes: entry.bytesReceived,
          timestamp: entry.timestamp,
        };
        return;
      }
      if (entry.kind !== "video") return;
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
    if (stats && audio) stats.audio = audio;
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
    this.media?.getTracks().forEach((track) => this.media?.removeTrack(track));
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
