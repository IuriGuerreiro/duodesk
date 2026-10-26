import type { ControlOffReason, NavAction } from "@duodesk/protocol";
import type { ControlView, NavOutcome } from "./control-link";

const offReasons: Record<ControlOffReason, string> = {
  unsupported: "Control isn't available for this kind of stream.",
  "service-disabled":
    "On the phone, tap Remote access and enable the DuoDesk accessibility service.",
  "not-allowed": "On the phone, tap Remote access.",
  revoked: "The phone stopped control. Start remote access again on the phone.",
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

export const navLabels: Record<NavAction, string> = {
  back: "Back",
  home: "Home",
  recents: "Recents",
};

/** Why a navigation button is disabled, or undefined when it can be pressed. */
export function navBlocked(
  view: ControlView,
  action: NavAction,
): string | undefined {
  if (view.paused) return "Control is paused on this PC.";
  if (!view.navActions)
    return "The phone app doesn't support navigation buttons. Update DuoDesk on the phone.";
  if (!view.navActions.includes(action))
    return `The phone says ${navLabels[action]} isn't available right now.`;
  if (view.busy) return "Waiting for the phone to answer.";
  return undefined;
}

const navOutcomes: Record<NavOutcome, string> = {
  sent: "sent…",
  // Android accepting the action does not prove the screen changed; the video shows what happened.
  done: "accepted by the phone.",
  cancelled: "cancelled by the phone.",
  failed: "refused by Android.",
  rejected: "not performed. Control changed on the phone.",
  unanswered: "no answer from the phone. Check the screen before trying again.",
};

export function navSummary(view: ControlView): string {
  const last = view.lastNav;
  return last ? `${navLabels[last.action]} ${navOutcomes[last.outcome]}` : "";
}
