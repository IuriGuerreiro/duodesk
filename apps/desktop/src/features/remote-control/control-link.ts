import {
  CONTROL_CHANNEL,
  INPUT_CHANNEL,
  INPUT_PACKET_LIFETIME_MS,
  RESULT_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  encodeInputCommand,
  parseCommandResult,
  parseControlCaps,
  parseControlStatus,
  videoMatchesDisplay,
  type ControlOffReason,
  type DisplayGeometry,
  type NormalizedPoint,
  type TypedKey,
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

/**
 * How the phone answered the last text or key command. Never carries the text itself.
 * `done` means Android handed it to the focused field, not that the field shows it: custom editors may
 * ignore input. `unconfirmed` means no answer arrived (timeout, revocation, disconnect), so it may or may
 * not have been typed. Everything else means nothing was typed.
 */
export type TypingOutcome =
  "done" | "nofield" | "rejected" | "failed" | "unconfirmed";

export interface TypingResult {
  seq: number;
  outcome: TypingOutcome;
}

export interface ControlView {
  phase: ControlPhase;
  reason?: ControlOffReason;
  geometry?: DisplayGeometry;
  epoch: number;
  /** The phone is still performing the last gesture, or has not answered it. */
  busy: boolean;
  /** Input is sent only when this is true. */
  paused: boolean;
  /** The phone accepts text and key commands for the current epoch. */
  text: boolean;
  /** The answer to the most recent text or key command, once it is known. */
  typing?: TypingResult;
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
  private pending?: {
    seq: number;
    epoch: number;
    since: number;
    typing: boolean;
  };
  /** Text capability, valid only for the epoch it was reported in. */
  private textCaps = false;
  private typing?: TypingResult;
  private paused = false;
  private closed = false;
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

  /** Watches for a silent phone and an unanswered command. Runs on a timer; tests call it directly. */
  check() {
    if (this.closed) return;
    const at = this.now();
    if (this.phone.state !== "waiting" && at - this.heardAt > STATUS_TIMEOUT_MS)
      this.reset();
    if (this.pending && at - this.pending.since > RESULT_TIMEOUT_MS) {
      // Never retried: a late text may still have been typed.
      this.forget();
      this.update();
    }
    // The settle window ending changes what the UI may show.
    this.update();
  }

  private receive(data: unknown) {
    if (this.closed || typeof data !== "string") return;
    let message;
    try {
      const parsed: unknown = JSON.parse(data);
      const type = (parsed as { type?: unknown }).type;
      message =
        type === "result"
          ? parseCommandResult(data, this.sessionId)
          : type === "caps"
            ? parseControlCaps(data, this.sessionId)
            : parseControlStatus(data, this.sessionId);
    } catch {
      // A malformed message from the phone changes nothing.
      return;
    }
    const at = this.now();
    if (message.type === "result") {
      const pending = this.pending;
      // A result for an older epoch or command was already given up on.
      if (pending?.seq !== message.seq || pending.epoch !== message.epoch)
        return;
      this.pending = undefined;
      if (pending.typing)
        this.typing = {
          seq: pending.seq,
          outcome:
            message.status === "done"
              ? "done"
              : message.status === "rejected"
                ? message.reason === "nofield"
                  ? "nofield"
                  : "rejected"
                : "failed",
        };
    } else if (message.type === "caps") {
      // Capabilities describe one epoch; the status that announced it always comes first.
      if (message.epoch !== this.epoch) return;
      this.textCaps = message.text;
    } else {
      this.heardAt = at;
      // Epochs only grow within a session. An older status is a late arrival.
      if (message.epoch < this.epoch) return;
      if (message.epoch !== this.epoch) {
        this.epoch = message.epoch;
        this.settleUntil = at + SETTLE_MS;
        this.textCaps = false;
        this.forget();
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
    this.textCaps = false;
    this.forget();
    this.update();
  }

  /** Gives up on the command in flight. A text or key command becomes `unconfirmed`, never silently lost. */
  private forget() {
    if (this.pending?.typing)
      this.typing = { seq: this.pending.seq, outcome: "unconfirmed" };
    this.pending = undefined;
  }

  /** Why input cannot be sent right now, or undefined if it can. */
  blocker(video: VideoSize, at = this.now()): ControlPhase | undefined {
    if (
      this.closed ||
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

  /** Why text cannot be sent right now, or undefined if it can. Text does not depend on the picture. */
  typeBlocker(): ControlPhase | undefined {
    if (
      this.closed ||
      this.phone.state !== "on" ||
      this.input.readyState !== "open"
    )
      return this.phone.state === "off" ? "off" : "waiting";
    if (this.paused) return "paused";
    if (!this.textCaps || this.now() < this.settleUntil) return "syncing";
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

  /**
   * Sends text for the focused field on the phone. Returns the command's `seq`, matched later by
   * `getView().typing`, or undefined when nothing was sent. `text` must already satisfy `validTypedText`.
   */
  typeText(text: string): number | undefined {
    return this.sendTyping({ type: "text", text });
  }

  typeKey(key: TypedKey): number | undefined {
    return this.sendTyping({ type: "key", key });
  }

  private sendTyping(
    body: { type: "text"; text: string } | { type: "key"; key: TypedKey },
  ): number | undefined {
    if (this.typeBlocker() || this.pending) return undefined;
    return this.transmit(this.epoch, body, true);
  }

  private send(
    epoch: number,
    video: VideoSize,
    body:
      | { type: "tap"; x: number; y: number }
      | { type: "swipe"; durationMs: number; points: NormalizedPoint[] },
  ): boolean {
    // One gesture at a time: input made while the phone is busy is dropped, not queued.
    if (this.blocker(video) || epoch !== this.epoch || this.pending)
      return false;
    return this.transmit(epoch, body, false) !== undefined;
  }

  private transmit(
    epoch: number,
    body:
      | { type: "tap"; x: number; y: number }
      | { type: "swipe"; durationMs: number; points: NormalizedPoint[] }
      | { type: "text"; text: string }
      | { type: "key"; key: TypedKey },
    typing: boolean,
  ): number | undefined {
    const at = this.now();
    if (this.input.bufferedAmount > BUFFER_LIMIT) return undefined;
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
      return undefined;
    }
    this.pending = { seq, epoch, since: at, typing };
    this.update();
    return seq;
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
    this.textCaps = false;
    this.forget();
    this.snapshot = this.compute();
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  }

  private compute(): ControlView {
    const base = {
      epoch: this.epoch,
      busy: this.pending !== undefined,
      paused: this.paused,
      text: !this.closed && this.textCaps && this.phone.state === "on",
      typing: this.typing,
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
      next.text === previous.text &&
      next.typing === previous.typing &&
      next.geometry === previous.geometry
    )
      return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}
