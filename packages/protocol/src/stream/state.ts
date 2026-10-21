export const STREAM_VERSION = 1;
export type StreamState =
  "idle" | "connecting" | "ready" | "streaming" | "stopped" | "failed";
