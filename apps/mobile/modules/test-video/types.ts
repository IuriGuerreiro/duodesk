import type { StreamState } from "@duodesk/protocol";

export type StreamMode = "screen" | "clip";

export interface SenderStats {
  codec: string;
  mbps: number;
  fps: number;
  width: number;
  height: number;
  qualityLimit: string;
}

export interface SenderStatus {
  state: StreamState;
  message?: string;
  stats?: SenderStats;
  mode?: StreamMode;
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
