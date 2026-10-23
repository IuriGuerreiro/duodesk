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
    title: "Connect to your PC",
    detail:
      "Open DuoDesk on your PC, create a connection, then scan its pairing code.",
    tone: "neutral",
  },
  connecting: {
    label: "Connecting",
    title: "Connecting to your PC",
    detail: "Keep DuoDesk open on both devices. This may take a few moments.",
    tone: "blue",
  },
  ready: {
    label: "Connected",
    title: "Your PC is ready",
    detail:
      "Share your screen, or let your PC tap and swipe with remote access.",
    tone: "green",
  },
  streaming: {
    label: "Video is live",
    title: "Your video is live",
    detail:
      "The test video is streaming to your PC. Your phone screen is not being shared.",
    tone: "green",
  },
  stopped: {
    label: "Disconnected",
    title: "Session ended",
    detail: "Create a new pairing code on your PC to start another session.",
    tone: "neutral",
  },
  failed: {
    label: "Connection issue",
    title: "Let’s reconnect",
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
    title: "You’re sharing your screen",
    detail: `Your display is mirrored to your PC. ${sound} You can stop from the DuoDesk notification or here.`,
    tone: "green",
  };
}
