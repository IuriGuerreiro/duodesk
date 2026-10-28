import type { RecoveryStatus } from "./state.ts";

export const RECOVERY_GRACE_MS = 3_000;
export const RECOVERY_ATTEMPT_MS = 8_000;
export const RECOVERY_BACKOFF_MS = 2_000;
export const RECOVERY_DEADLINE_MS = 25_000;
export const RECOVERY_ATTEMPTS = 2;

/** One interruption budget. Only the media sender supplies restart. */
export class ConnectionRecovery {
  private active = false;
  private closed = false;
  private attempt = 0;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;

  private readonly options: {
    changed: (status: RecoveryStatus) => void;
    exhausted: () => void;
    restart?: () => void;
  };

  constructor(options: ConnectionRecovery["options"]) {
    this.options = options;
  }

  interrupt() {
    if (this.closed || this.active) return;
    this.active = true;
    this.attempt = 0;
    this.publish();
    this.deadline = setTimeout(() => this.exhaust(), RECOVERY_DEADLINE_MS);
    if (this.options.restart)
      this.timer = setTimeout(() => this.reconnect(), RECOVERY_GRACE_MS);
  }

  reconnect() {
    if (this.closed || !this.active || this.running || !this.options.restart)
      return;
    clearTimeout(this.timer);
    if (this.attempt >= RECOVERY_ATTEMPTS) return this.exhaust();
    this.running = true;
    this.attempt++;
    this.publish();
    this.timer = setTimeout(() => {
      this.running = false;
      if (this.attempt >= RECOVERY_ATTEMPTS) return this.exhaust();
      this.publish();
      this.timer = setTimeout(() => this.reconnect(), RECOVERY_BACKOFF_MS);
    }, RECOVERY_ATTEMPT_MS);
    this.options.restart();
  }

  connected() {
    if (this.closed) return;
    this.active = false;
    this.running = false;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
  }

  close() {
    this.connected();
    this.closed = true;
  }

  private publish() {
    this.options.changed({
      state: this.running ? "reconnecting" : "interrupted",
      attempt: this.attempt,
      canReconnect:
        !!this.options.restart &&
        !this.running &&
        this.attempt < RECOVERY_ATTEMPTS,
    });
  }

  private exhaust() {
    if (this.closed || !this.active) return;
    this.close();
    this.options.exhausted();
  }
}
