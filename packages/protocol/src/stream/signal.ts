import { exact, hex, id, record } from "./guards.ts";

export const MAX_SIGNAL_BYTES = 65_536;

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
