/**
 * Minimal shared protocol package to verify monorepo package resolution.
 * Protocol message schemas, capability definitions, and serialization
 * will be defined in future milestone work.
 */
export const PROTOCOL_VERSION = "0.1.0";
export * from "./stream/direction.ts";
export * from "./control/index.ts";
export * from "./stream/invitation.ts";
export * from "./stream/signal.ts";
export * from "./stream/state.ts";
export * from "./stream/recovery.ts";
export * from "./stream/settings.ts";

export interface ProtocolHandshake {
  version: string;
  clientType: "desktop" | "mobile";
}
