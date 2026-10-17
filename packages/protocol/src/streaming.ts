export const STREAM_VERSION = 1;
export const MAX_SIGNAL_BYTES = 65_536;
export type StreamState =
  "idle" | "connecting" | "ready" | "streaming" | "stopped" | "failed";
export interface Invitation {
  v: 1;
  sessionId: string;
  url: string;
  token: string;
  fingerprint: string;
  expiresAt: number;
}
export type Signal = { v: 1; sessionId: string } & (
  | { type: "pair"; token: string }
  | { type: "paired" }
  | { type: "offer" | "answer"; sdp: string }
  | {
      type: "candidate";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number;
    }
  | { type: "stop" }
);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

export function parseInvitation(text: string, now = Date.now()): Invitation {
  if (text.length > 2048) throw new Error("Invitation is too large.");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    !exact(value, [
      "v",
      "sessionId",
      "url",
      "token",
      "fingerprint",
      "expiresAt",
    ]) ||
    value.v !== 1 ||
    !id(value.sessionId) ||
    !hex(value.token) ||
    !hex(value.fingerprint) ||
    typeof value.url !== "string" ||
    !/^wss:\/\/(\d{1,3}\.){3}\d{1,3}:\d{1,5}\/$/.test(value.url) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + 5 * 60_000
  )
    throw new Error(
      "Invalid or expired invitation. Create a new one on Windows.",
    );
  const endpoint = new URL(value.url);
  if (
    endpoint.hostname.split(".").some((part) => Number(part) > 255) ||
    Number(endpoint.port) < 1 ||
    Number(endpoint.port) > 65535
  ) {
    throw new Error("Invalid receiver address.");
  }
  return value as unknown as Invitation;
}

export function parseSignal(text: string, sessionId: string): Signal {
  if (new TextEncoder().encode(text).length > MAX_SIGNAL_BYTES)
    throw new Error("Signal is too large.");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    value.v !== 1 ||
    value.sessionId !== sessionId ||
    !id(value.sessionId)
  )
    throw new Error("Invalid signal session.");
  const base = ["v", "sessionId", "type"];
  const valid =
    value.type === "pair"
      ? exact(value, [...base, "token"]) && hex(value.token)
      : value.type === "paired" || value.type === "stop"
        ? exact(value, base)
        : value.type === "offer" || value.type === "answer"
          ? exact(value, [...base, "sdp"]) &&
            typeof value.sdp === "string" &&
            value.sdp.length > 0
          : value.type === "candidate"
            ? exact(value, [...base, "candidate", "sdpMid", "sdpMLineIndex"]) &&
              typeof value.candidate === "string" &&
              value.candidate.length > 0 &&
              value.candidate.length <= 8192 &&
              (value.sdpMid === null ||
                (typeof value.sdpMid === "string" &&
                  value.sdpMid.length <= 256)) &&
              Number.isInteger(value.sdpMLineIndex) &&
              Number(value.sdpMLineIndex) >= 0 &&
              Number(value.sdpMLineIndex) <= 32
            : false;
  if (!valid) throw new Error("Invalid signaling message.");
  return value as unknown as Signal;
}
