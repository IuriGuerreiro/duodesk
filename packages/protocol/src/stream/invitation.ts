import { isDirection, type Direction } from "./direction.ts";
import { exact, hex, id, record } from "./guards.ts";

export interface Invitation {
  v: 1;
  direction: Direction;
  sessionId: string;
  url: string;
  token: string;
  fingerprint: string;
  expiresAt: number;
}

export function parseInvitation(text: string, now = Date.now()): Invitation {
  if (text.length > 2048) throw new Error("Invitation is too large.");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    !exact(value, [
      "v",
      "direction",
      "sessionId",
      "url",
      "token",
      "fingerprint",
      "expiresAt",
    ]) ||
    value.v !== 1 ||
    !isDirection(value.direction) ||
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
