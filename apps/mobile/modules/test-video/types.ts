import type { StreamState } from "@duodesk/protocol";

export type StreamMode = "screen" | "clip";

/**
 * Playback audio (sound from other apps, never the microphone) for screen sharing.
 * Anything other than "active" means the PC gets video only, or silence if "failed" happens mid-session.
 */
export type AudioState =
  "off" | "starting" | "active" | "denied" | "unsupported" | "failed";

export interface SenderStats {
  codec: string;
  mbps: number;
  fps: number;
  width: number;
  height: number;
  qualityLimit: string;
  /** Opus audio bitrate in kbit/s, present once audio is flowing. */
  audioKbps?: number;
}

export interface SenderStatus {
  state: StreamState;
  message?: string;
  stats?: SenderStats;
  mode?: StreamMode;
  audio?: AudioState;
  /** Why audio is not active, when the user needs to know. */
  audioMessage?: string;
}

export type SavedDesktop = {
  fingerprint: string;
  phoneId: string;
  address: string;
  createdAt: number;
  keyAvailable: boolean;
};
