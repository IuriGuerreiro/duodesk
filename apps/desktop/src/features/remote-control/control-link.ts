import {
  CONTROL_CHANNEL,
  INPUT_CHANNEL,
  INPUT_PACKET_LIFETIME_MS,
  RESULT_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  encodeInputCommand,
  parseCommandResult,
  parseControlStatus,
  videoMatchesDisplay,
  type ControlOffReason,
  type DisplayGeometry,
  type NormalizedPoint,
} from "@duodesk/protocol";

/** After the phone's screen changes shape, ignore input until the new frames have had time to arrive. */
export const SETTLE_MS = 400;
const BUFFER_LIMIT = 16_384;

export type ControlPhase =
  /** The phone has not reported yet, or has gone quiet. */
  | "waiting"
  /** The phone owner has not allowed control, or has taken it back. */
  | "off"
  /** Allowed by the phone, but this desktop chose to stop sending. */
  | "paused"
  /** Allowed, but the picture and the phone's reported screen do not agree yet. */
  | "syncing"
  | "active";

export interface ControlView {
  phase: ControlPhase;
  reason?: ControlOffReason;
  geometry?: DisplayGeometry;
  epoch: number;
  /** The phone is still performing the last gesture, or has not answered it. */
  busy: boolean;
  /** Input is sent only when this is true. */
  paused: boolean;
}

export interface VideoSize {
  width: number;
  height: number;
}

type Phone =
  | { state: "waiting" }
  | { state: "off"; reason: ControlOffReason }
  | { state: "on"; geometry: DisplayGeometry };

/**
 * The desktop end of phone remote control. The phone decides whether control is on; this class only
 * reports that and sends finished taps and swipes, one at a time, for the phone's current epoch.
 */
export class ControlLink {
  private control: RTCDataChannel;
  private input: RTCDataChannel;
  private phone: Phone = { state: "waiting" };
  private epoch = -1;
  private heardAt = 0;
  private settleUntil = 0;
  private seq = 0;
  private pending?: { seq: number; since: number };
  private paused = false;
  private closed = false;
  private suspended = false;
  private minimumEpoch = 0;
  private listeners = new Set<() => void>();
  private snapshot: ControlView;
  private timer: ReturnType<typeof setInterval>;

  private sessionId: string;
  private now: () => number;

  constructor(
    peer: RTCPeerConnection,
    sessionId: string,
    now: () => number = () => Date.now(),
  ) {
    this.sessionId = sessionId;
    this.now = now;
    // Negotiated channels: both ends create them by id, so neither waits for an announcement.
    this.control = peer.createDataChannel(CONTROL_CHANNEL.label, {
      negotiated: true,
      id: CONTROL_CHANNEL.id,
      ordered: true,
    });
    this.input = peer.createDataChannel(INPUT_CHANNEL.label, {
      negotiated: true,
      id: INPUT_CHANNEL.id,
      ordered: true,
      maxPacketLifeTime: INPUT_PACKET_LIFETIME_MS,
    });
    this.control.onmessage = (event) => this.receive(event.data);
    this.control.onclose = () => this.reset();
    this.input.onclose = () => this.reset();
    this.snapshot = this.compute();
    this.timer = setInterval(() => this.check(), 500);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getView = (): ControlView => this.snapshot;

  setPaused(paused: boolean) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.update();
  }

  interrupt() {
    if (this.suspended) return;
    this.suspended = true;
    this.minimumEpoch = Math.max(this.minimumEpoch, this.epoch + 1);
    this.reset();
  }

  resume() {
    this.suspended = false;
  }

  /** Watches for a silent phone and an unanswered command. Runs on a timer; tests call it directly. */
  check() {
    if (this.closed) return;
    const at = this.now();
    if (this.phone.state !== "waiting" && at - this.heardAt > STATUS_TIMEOUT_MS)
      this.reset();
    if (this.pending && at - this.pending.since > RESULT_TIMEOUT_MS) {
      this.pending = undefined;
      this.update();
    }
    // The settle window ending changes what the UI may show.
    this.update();
  }

  private receive(data: unknown) {
    if (this.closed || this.suspended || typeof data !== "string") return;
    let message;
    try {
      const parsed: unknown = JSON.parse(data);
      const type = (parsed as { type?: unknown }).type;
      message =
        type === "result"
          ? parseCommandResult(data, this.sessionId)
          : parseControlStatus(data, this.sessionId);
    } catch {
      // A malformed message from the phone changes nothing.
      return;
    }
    const at = this.now();
    if (message.type === "result") {
      if (this.pending?.seq === message.seq) this.pending = undefined;
    } else {
      this.heardAt = at;
      // Epochs only grow within a session. An older status is a late arrival.
      if (message.epoch < this.epoch || message.epoch < this.minimumEpoch)
        return;
      if (message.epoch !== this.epoch) {
        this.epoch = message.epoch;
        this.settleUntil = at + SETTLE_MS;
        this.pending = undefined;
      }
      this.phone =
        message.state === "on"
          ? { state: "on", geometry: message.geometry }
          : { state: "off", reason: message.reason };
    }
    this.update();
  }

  private reset() {
    this.phone = { state: "waiting" };
    this.epoch = -1;
    this.pending = undefined;
    this.update();
  }

  /** Why input cannot be sent right now, or undefined if it can. */
  blocker(video: VideoSize, at = this.now()): ControlPhase | undefined {
    if (
      this.closed ||
      this.suspended ||
      this.phone.state !== "on" ||
      this.input.readyState !== "open"
    ) {
      return this.phone.state === "off" ? "off" : "waiting";
    }
    if (this.paused) return "paused";
    if (
      at < this.settleUntil ||
      !videoMatchesDisplay(this.phone.geometry, video.width, video.height)
    )
      return "syncing";
    return undefined;
  }

  /** The epoch a gesture started in. A gesture that outlives an epoch change is dropped, never remapped. */
  currentEpoch() {
    return this.epoch;
  }

  tap(point: NormalizedPoint, epoch: number, video: VideoSize): boolean {
    return this.send(epoch, video, { type: "tap", x: point[0], y: point[1] });
  }

  swipe(
    points: NormalizedPoint[],
    durationMs: number,
    epoch: number,
    video: VideoSize,
  ): boolean {
    return this.send(epoch, video, { type: "swipe", durationMs, points });
  }

  private send(
    epoch: number,
    video: VideoSize,
    body:
      | { type: "tap"; x: number; y: number }
      | { type: "swipe"; durationMs: number; points: NormalizedPoint[] },
  ): boolean {
    const at = this.now();
    // One gesture at a time: input made while the phone is busy is dropped, not queued.
    if (this.blocker(video, at) || epoch !== this.epoch || this.pending)
      return false;
    if (this.input.bufferedAmount > BUFFER_LIMIT) return false;
    const seq = ++this.seq;
    try {
      this.input.send(
        encodeInputCommand({
          v: 1,
          sessionId: this.sessionId,
          epoch,
          seq,
          ...body,
        }),
      );
    } catch {
      return false;
    }
    this.pending = { seq, since: at };
    this.update();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.control.onmessage = null;
    this.control.onclose = null;
    this.input.onclose = null;
    this.control.close();
    this.input.close();
    this.phone = { state: "waiting" };
    this.pending = undefined;
    this.snapshot = this.compute();
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }

  private compute(): ControlView {
    const base = {
      epoch: this.epoch,
      busy: this.pending !== undefined,
      paused: this.paused,
    };
    if (this.closed || this.phone.state === "waiting")
      return { ...base, phase: "waiting" };
    if (this.phone.state === "off")
      return { ...base, phase: "off", reason: this.phone.reason };
    const geometry = this.phone.geometry;
    if (this.paused) return { ...base, phase: "paused", geometry };
    if (this.now() < this.settleUntil)
      return { ...base, phase: "syncing", geometry };
    return { ...base, phase: "active", geometry };
  }

  private update() {
    const next = this.compute();
    const previous = this.snapshot;
    if (
      next.phase === previous.phase &&
      next.reason === previous.reason &&
      next.epoch === previous.epoch &&
      next.busy === previous.busy &&
      next.paused === previous.paused &&
      next.geometry === previous.geometry
    )
      return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}
