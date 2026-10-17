import type { StreamState } from "@duodesk/protocol";
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
}
