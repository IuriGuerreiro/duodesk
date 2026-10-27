import type { StreamSettings, StreamState } from "@duodesk/protocol";

export type StreamMode = "screen" | "clip";

/**
 * Playback audio (sound from other apps, never the microphone) for screen sharing.
 * Anything other than "active" means the PC gets video only, or silence if "failed" happens mid-session.
 */
export type AudioState =
  "off" | "starting" | "active" | "denied" | "unsupported" | "failed";

/**
 * Whether a paired PC may tap and swipe on this phone during the current screen-sharing session.
 * "off" with reason "service-disabled" means the Android accessibility service is not turned on.
 */
export interface ControlStatus {
  state: "on" | "off";
  reason?:
    | "unsupported"
    | "service-disabled"
    | "not-allowed"
    | "revoked"
    | "geometry-unknown";
  /** The accessibility service is connected, which is required but not enough to allow control. */
  serviceEnabled: boolean;
}

export interface SenderStats {
  codec: string;
  mbps: number;
  fps: number;
  width: number;
  height: number;
  qualityLimit: string;
  /** Opus audio bitrate in kbit/s, present once audio is flowing. */
  audioKbps?: number;
  /** Screen sharing only: frames where the screen actually changed. `fps` also counts idle refresh frames. */
  screenFps?: number;
}

export interface SenderStatus {
  state: StreamState;
  message?: string;
  stats?: SenderStats;
  mode?: StreamMode;
  audio?: AudioState;
  /** Why audio is not active, when the user needs to know. */
  audioMessage?: string;
  /** Present during a screen-sharing session. */
  control?: ControlStatus;
  /** Screen sharing only: the user's chosen limits, as the phone accepted them. */
  requested?: StreamSettings;
  /** Screen sharing only: the capture size applied to this display. `stats` holds what is really sent. */
  capture?: { width: number; height: number };
}

export interface ViewerStats {
  codec: string;
  mbps: number;
  fps: number;
  width: number;
  height: number;
}

export interface ViewerStatus {
  state: StreamState;
  message?: string;
  stats?: ViewerStats;
}
