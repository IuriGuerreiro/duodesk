import type { SenderStatus } from "../../../modules/test-video";

type SessionCopy = {
  label: string;
  title: string;
  detail: string;
  tone: "neutral" | "blue" | "green" | "red";
};

export const sessionCopy = {
  idle: {
    label: "Not connected",
    title: "Your phone.\nMeet your PC.",
    detail:
      "Pair with DuoDesk on your PC to send your screen or video over your local network.",
    tone: "neutral",
  },
  connecting: {
    label: "Connecting",
    title: "Making the\nconnection.",
    detail: "Keep DuoDesk open on both devices. This may take a few moments.",
    tone: "blue",
  },
  ready: {
    label: "Connected",
    title: "Connected.\nReady when you are.",
    detail:
      "Your PC is paired. Share your screen or start the test video to check your connection.",
    tone: "green",
  },
  streaming: {
    label: "Video is live",
    title: "Test video.\nLive on your PC.",
    detail:
      "The test video is streaming to your PC. Your phone screen is not being shared.",
    tone: "green",
  },
  stopped: {
    label: "Disconnected",
    title: "Session ended.\nConnect again.",
    detail: "Create a new pairing code on your PC to start another session.",
    tone: "neutral",
  },
  failed: {
    label: "Connection issue",
    title: "Let’s get you\nreconnected.",
    detail:
      "Check that both devices are on the same network, then create a new pairing code on your PC.",
    tone: "red",
  },
} satisfies Record<SenderStatus["state"], SessionCopy>;

export function screenStreamingCopy(audio: SenderStatus["audio"]): SessionCopy {
  const sound =
    audio === "active"
      ? "Sound from other apps is sent too. Apps that block capture stay silent."
      : "Sound is not shared.";
  return {
    label: "Screen is live",
    title: "Your screen.\nLive on your PC.",
    detail: `Your display is mirrored to your PC. ${sound} You can stop from the DuoDesk notification or here.`,
    tone: "green",
  };
}

type ControlCopy = {
  state: "on" | "off";
  /** "settings" opens Android's Accessibility settings, "allow" grants this session, "stop" takes it back. */
  action: "settings" | "allow" | "stop";
  title: string;
  detail: string;
  buttonLabel: string;
};

/** What the phone owner is told about letting the PC tap and swipe. Returns undefined when it does not apply. */
export function controlCopy(
  control: SenderStatus["control"],
): ControlCopy | undefined {
  if (!control || control.reason === "unsupported") return undefined;
  if (control.state === "on") {
    return {
      state: "on",
      action: "stop",
      title: "Your PC can control this phone",
      detail:
        "It can tap and swipe while this screen share lasts. Stop it here or from the DuoDesk notification. It also ends when you disconnect.",
      buttonLabel: "Stop control",
    };
  }
  if (!control.serviceEnabled) {
    return {
      state: "off",
      action: "settings",
      title: "Let your PC tap and swipe",
      detail:
        "First turn on the DuoDesk accessibility service in Android settings. It can only perform taps and swipes; it cannot read your screen. If Android says the setting is restricted, open DuoDesk's App info, tap ⋮, choose Allow restricted settings, then try again. Turning the service on does not give your PC control yet.",
      buttonLabel: "Open accessibility settings",
    };
  }
  const lead =
    control.reason === "revoked"
      ? "Control was stopped. "
      : control.reason === "geometry-unknown"
        ? "Control turned off because the screen size could not be confirmed. "
        : "";
  return {
    state: "off",
    action: "allow",
    title: "Let your PC tap and swipe",
    detail: `${lead}Allow your PC to tap and swipe on this phone for this screen share only. Taps and swipes appear as if you touched the screen. You stay in charge and can stop at any time. Android's protected screens, like the lock screen and some payment screens, may ignore them.`,
    buttonLabel: "Allow control",
  };
}
