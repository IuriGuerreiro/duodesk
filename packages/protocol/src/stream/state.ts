export const STREAM_VERSION = 1;
export type StreamState =
  | "idle"
  | "connecting"
  | "ready"
  | "streaming"
  | "interrupted"
  | "reconnecting"
  | "disconnected"
  | "stopped"
  | "failed";

export type ConnectionFailure =
  | "unreachable"
  | "invitation-expired"
  | "connection-lost"
  | "unrecoverable"
  | "permission-revoked";

export interface RecoveryStatus {
  state: "interrupted" | "reconnecting";
  attempt: number;
  canReconnect: boolean;
}
