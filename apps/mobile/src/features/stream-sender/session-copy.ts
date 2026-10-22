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
      "Pair with DuoDesk on your PC to send your screen or video, or to watch your PC screen, over your local network.",
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
