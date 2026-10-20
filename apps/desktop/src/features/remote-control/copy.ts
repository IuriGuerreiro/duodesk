import type { ControlOffReason } from "@duodesk/protocol";
import type { ControlView } from "./control-link";

const offReasons: Record<ControlOffReason, string> = {
  unsupported: "Control isn't available for this kind of stream.",
  "service-disabled":
    "On the phone, turn on the DuoDesk accessibility service, then allow control.",
  "not-allowed": "On the phone, tap “Allow control”.",
  revoked: "The phone stopped control. Allow it again on the phone.",
  "geometry-unknown":
    "The phone can't confirm its screen size, so control is off.",
};

/** One line the toolbar can show. `mismatch` means the picture does not yet match the phone's screen. */
export function controlSummary(view: ControlView, mismatch: boolean): string {
  switch (view.phase) {
    case "waiting":
      return "Control: waiting for the phone";
    case "off":
      return `Control off. ${offReasons[view.reason ?? "not-allowed"]}`;
    case "paused":
      return "Control paused on this PC";
    case "syncing":
      return "Control: syncing with the phone's screen…";
    case "active":
      return mismatch
        ? "Control: syncing with the phone's screen…"
        : "Control on: click to tap, drag to swipe";
  }
}
