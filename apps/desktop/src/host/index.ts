import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Signal, StreamState } from "@duodesk/protocol";
export type StreamEvent =
  | { kind: "pairingstatus"; sessionId: string; status: "used" | "locked" }
  | { kind: "pairing"; sessionId: string; requestId: string; message: string }
  | { kind: "signal"; signal: Signal }
  | { kind: "state"; sessionId: string; state: StreamState };
type Command =
  | "stream_pair_reply"
  | "stream_interfaces"
  | "stream_start"
  | "stream_send"
  | "stream_stop";
interface DesktopHost {
  invoke<T>(command: Command, args?: Record<string, unknown>): Promise<T>;
  subscribe(callback: (event: StreamEvent) => void): () => void;
}
declare global {
  interface Window {
    duoDesk?: DesktopHost;
  }
}
export const isDesktop = () => !!window.duoDesk || isTauri();
export function invoke<T = void>(
  command: Command,
  args?: Record<string, unknown>,
): Promise<T> {
  return window.duoDesk
    ? window.duoDesk.invoke<T>(command, args)
    : tauriInvoke<T>(command, args);
}
export async function subscribe(
  callback: (event: StreamEvent) => void,
): Promise<() => void> {
  return window.duoDesk
    ? window.duoDesk.subscribe(callback)
    : listen<StreamEvent>("stream-event", ({ payload }) => callback(payload));
}
