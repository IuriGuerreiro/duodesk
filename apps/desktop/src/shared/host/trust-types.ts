import type { Direction } from "@duodesk/protocol";
export interface TrustStatus {
  available: boolean;
  error?: string;
  name: string;
  endpoint: {
    interface: string;
    address?: string;
    listening: boolean;
    error?: string;
  } | null;
  devices: {
    id: string;
    name: string;
    createdAt: number;
    available: boolean;
  }[];
}
export type TrustEvent =
  | { type: "status"; status: TrustStatus }
  | {
      type: "enroll";
      sessionId: string;
      state: string;
      peerName?: string;
      message?: string;
    }
  | {
      type: "request" | "accepted";
      requestId: string;
      deviceId: string;
      direction: Direction;
    }
  | { type: "rejected" | "cancelled"; requestId: string; deviceId: string }
  | { type: "forgotten"; deviceId: string };
