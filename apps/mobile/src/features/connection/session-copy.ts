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
      "Connect to DuoDesk on your PC to send video over your local network.",
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
    detail: "Your PC is paired. Start the test video to check your connection.",
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
    detail: "Create a fresh invitation on your PC to start another session.",
    tone: "neutral",
  },
  failed: {
    label: "Connection issue",
    title: "Let’s get you\nreconnected.",
    detail:
      "Check that both devices are on the same network, then create a new PC invitation.",
    tone: "red",
  },
} satisfies Record<SenderStatus["state"], SessionCopy>;
