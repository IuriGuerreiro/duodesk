import type { SenderStatus } from "../../../modules/test-video/types";

export type RemoteAccessStep =
  "idle" | "checking" | "settings" | "sharing" | "allowing";

interface Actions {
  status(): SenderStatus;
  serviceEnabled(): Promise<boolean>;
  openSettings(): Promise<void>;
  shareScreen(): Promise<boolean>;
  allowControl(): Promise<void>;
  changed(step: RemoteAccessStep): void;
  failed(message: string): void;
}

/** One explicit Remote access press, including the round trip through Android settings. */
export class RemoteAccessRequest {
  private step: RemoteAccessStep = "idle";
  private cancelled = false;
  private actions: Actions;
  constructor(actions: Actions) {
    this.actions = actions;
  }

  waitingForSettings() {
    return !this.cancelled && this.step === "settings";
  }

  cancel() {
    this.cancelled = true;
    this.setStep("idle");
  }

  private setStep(step: RemoteAccessStep) {
    this.step = step;
    this.actions.changed(step);
  }

  async start() {
    if (this.cancelled || this.step !== "idle") return;
    this.setStep("checking");
    try {
      const enabled = await this.actions.serviceEnabled();
      if (this.cancelled) return;
      if (!enabled) {
        this.setStep("settings");
        await this.actions.openSettings();
        return;
      }
      await this.continue();
    } catch (error) {
      this.fail(error);
    }
  }

  async resume() {
    if (!this.waitingForSettings()) return;
    this.setStep("checking");
    try {
      const enabled = await this.actions.serviceEnabled();
      if (this.cancelled) return;
      if (!enabled) {
        this.cancel();
        return;
      }
      await this.continue();
    } catch (error) {
      this.fail(error);
    }
  }

  private async continue() {
    const status = this.actions.status();
    if (status.state === "streaming" && status.mode === "screen") {
      await this.allow();
    } else if (status.state === "ready") {
      this.setStep("sharing");
      if (!(await this.actions.shareScreen())) this.cancel();
      if (!this.cancelled) this.statusChanged(this.actions.status());
    } else {
      this.cancel();
    }
  }

  statusChanged(status: SenderStatus) {
    if (this.cancelled) return;
    if (
      status.state === "failed" ||
      status.state === "stopped" ||
      status.state === "idle"
    ) {
      this.cancel();
    } else if (
      this.step === "sharing" &&
      status.state === "streaming" &&
      status.mode === "screen" &&
      status.control &&
      status.control.reason !== "geometry-unknown"
    ) {
      void this.allow().catch((error: unknown) => this.fail(error));
    }
  }

  private async allow() {
    this.setStep("allowing");
    await this.actions.allowControl();
    if (!this.cancelled) this.cancel();
  }

  private fail(error: unknown) {
    if (this.cancelled) return;
    this.cancel();
    this.actions.failed(
      error instanceof Error
        ? error.message
        : "Could not start remote access. Try again.",
    );
  }
}
