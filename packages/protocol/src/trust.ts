/**
 * Remembered devices, protocol v1. Three separate layers:
 * - display metadata and address hints (names, last address): never used for trust;
 * - mutual trust: each install's P-256 identity, enrolled once with explicit approval on both devices;
 * - session permission: every new stream still needs an explicit request and local acceptance.
 *
 * Native code (Rust on desktop, Kotlin/Swift on the phone) owns keys, signatures and these
 * messages. JavaScript only validates shapes, shows prompts and passes the user's decisions.
 *
 * Wire encodings: P-256 public keys are SEC1 uncompressed points (65 bytes, `04 || X || Y`),
 * written as lowercase hex. Key fingerprints are SHA-256 of those 65 bytes. Signatures are
 * ASN.1 DER ECDSA over SHA-256 of the UTF-8 transcript, lowercase hex. Nonces are 32 random bytes.
 */
import { isDirection, type Direction, type Role } from "./stream/direction.ts";
import { exact, id, record } from "./stream/guards.ts";
import { parseDesktopAddress } from "./pairing.ts";
import { cleanText } from "./text.ts";

/** Pairing v2 feature that enables enrollment messages on the paired session socket. */
export const TRUST_FEATURE = "trust-v1";
export const ENROLL_PURPOSE = "duodesk-enroll-v1";
export const RECONNECT_PURPOSE = "duodesk-reconnect-v1";
/** DNS-SD type of the remembered-device endpoint. Separate from pairing's `_duodesk._tcp`. */
export const REMEMBERED_SERVICE_TYPE = "_duodesk-trust._tcp";
export const LINK_MAX_BYTES = 4096;
export const DEVICE_NAME_MAX = 40;
/** A connect request the other device has not answered is cancelled after this. */
export const CONNECT_REQUEST_MS = 60_000;
/** An unanswered enrollment is cancelled after this. */
export const ENROLL_TIMEOUT_MS = 120_000;

export const isPublicKey = (value: unknown): value is string =>
  typeof value === "string" && /^04[0-9a-f]{128}$/.test(value);
export const isNonce = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const isRequestId = id;

/** Strict DER `SEQUENCE { INTEGER r, INTEGER s }` with minimal, positive P-256 sized integers. */
export function isSignature(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 144 ||
    !/^(?:[0-9a-f]{2})+$/.test(value)
  )
    return false;
  const bytes = value.match(/../g)!.map((b) => parseInt(b, 16));
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return false;
  let at = 2;
  for (let i = 0; i < 2; i++) {
    if (bytes[at] !== 0x02) return false;
    const size = bytes[at + 1] ?? 0;
    const first = bytes[at + 2] ?? 0;
    const second = bytes[at + 3] ?? 0;
    if (size < 1 || size > 33 || at + 2 + size > bytes.length) return false;
    if (first & 0x80) return false;
    if (size > 1 && first === 0 && !(second & 0x80)) return false;
    at += 2 + size;
  }
  return at === bytes.length;
}

/** Cleans a peer-suggested or user-typed device name. Display only. */
export const deviceName = (value: unknown): string | null =>
  cleanText(value, DEVICE_NAME_MAX);

export interface EnrollTranscript {
  sessionId: string;
  /** SHA-256 of the session's TLS leaf certificate (the invitation fingerprint). */
  certificateFingerprint: string;
  /** SHA-256 of the 32 invitation token bytes. */
  tokenHash: string;
  desktopKey: string;
  phoneKey: string;
  desktopNonce: string;
  phoneNonce: string;
}

const hex64 = /^[0-9a-f]{64}$/;

/** The exact bytes each device signs to enroll. `signer` keeps one device's signature from verifying as the other's. */
export function enrollTranscript(signer: Role, t: EnrollTranscript): string {
  if (
    !id(t.sessionId) ||
    !hex64.test(t.certificateFingerprint) ||
    !hex64.test(t.tokenHash) ||
    !isPublicKey(t.desktopKey) ||
    !isPublicKey(t.phoneKey) ||
    !isNonce(t.desktopNonce) ||
    !isNonce(t.phoneNonce) ||
    t.desktopKey === t.phoneKey
  )
    throw new Error("Invalid enrollment transcript.");
  return [
    ENROLL_PURPOSE,
    signer,
    t.sessionId,
    t.certificateFingerprint,
    t.tokenHash,
    t.desktopKey,
    t.phoneKey,
    t.desktopNonce,
    t.phoneNonce,
  ].join("\n");
}

/** The phone signs this to answer one remembered-endpoint challenge. The TLS pin authenticates the desktop. */
export function reconnectTranscript(t: {
  desktopKey: string;
  phoneKey: string;
  serverNonce: string;
  clientNonce: string;
}): string {
  if (
    !isPublicKey(t.desktopKey) ||
    !isPublicKey(t.phoneKey) ||
    !isNonce(t.serverNonce) ||
    !isNonce(t.clientNonce)
  )
    throw new Error("Invalid reconnect transcript.");
  return [
    RECONNECT_PURPOSE,
    "phone",
    t.desktopKey,
    t.phoneKey,
    t.serverNonce,
    t.clientNonce,
  ].join("\n");
}

/** Enrollment messages ride the paired session socket and carry its `v` and `sessionId`. */
export const ENROLL_FIELDS = {
  enroll_hello: [],
  enroll_request: ["key", "nonce", "name"],
  enroll_accept: ["key", "nonce", "name", "signature"],
  enroll_confirm: ["signature"],
  enroll_saved: [],
  enroll_cancel: [],
} as const satisfies Record<string, readonly string[]>;
export type EnrollType = keyof typeof ENROLL_FIELDS;

/** Only a phone announces support; it does so only after the desktop authenticated `trust-v1`. */
export const ENROLL_ROUTES: Record<Role, readonly EnrollType[]> = {
  phone: [
    "enroll_hello",
    "enroll_request",
    "enroll_accept",
    "enroll_confirm",
    "enroll_saved",
    "enroll_cancel",
  ],
  desktop: [
    "enroll_request",
    "enroll_accept",
    "enroll_confirm",
    "enroll_saved",
    "enroll_cancel",
  ],
};

export type EnrollMessage = { v: 1; sessionId: string } & (
  | { type: "enroll_hello" | "enroll_saved" | "enroll_cancel" }
  | { type: "enroll_request"; key: string; nonce: string; name: string }
  | {
      type: "enroll_accept";
      key: string;
      nonce: string;
      name: string;
      signature: string;
    }
  | { type: "enroll_confirm"; signature: string }
);

const fieldValid: Record<string, (value: unknown) => boolean> = {
  key: isPublicKey,
  nonce: isNonce,
  name: (v) => typeof v === "string" && v.length <= 160 && deviceName(v) === v,
  signature: isSignature,
  requestId: isRequestId,
  direction: isDirection,
  invitation: (v) => typeof v === "string" && v.length <= 2048,
};

function parseBounded(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > LINK_MAX_BYTES)
    throw new Error("Trust message is too large.");
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.v !== 1 || typeof value.type !== "string")
    throw new Error("Invalid trust message.");
  return value;
}

export function parseEnrollMessage(
  text: string,
  route: { sessionId: string; from: Role },
): EnrollMessage {
  const value = parseBounded(text);
  const type = value.type as EnrollType;
  const extra = Object.prototype.hasOwnProperty.call(ENROLL_FIELDS, type)
    ? ENROLL_FIELDS[type]
    : undefined;
  if (
    !extra ||
    !ENROLL_ROUTES[route.from].includes(type) ||
    value.sessionId !== route.sessionId ||
    !id(value.sessionId) ||
    !exact(value, ["v", "sessionId", "type", ...extra]) ||
    !extra.every((key) => fieldValid[key]!(value[key]))
  )
    throw new Error("Invalid enrollment message.");
  return value as unknown as EnrollMessage;
}

/** Messages on an authenticated remembered link. No session ID: the link outlives sessions. */
export const LINK_FIELDS = {
  challenge: ["nonce"],
  auth: ["key", "nonce", "signature"],
  authenticated: [],
  connect_request: ["requestId", "direction"],
  connect_accept: ["requestId"],
  connect_reject: ["requestId"],
  connect_cancel: ["requestId"],
  invitation: ["requestId", "invitation"],
  forget: [],
} as const satisfies Record<string, readonly string[]>;
export type LinkType = keyof typeof LINK_FIELDS;

export const LINK_ROUTES: Record<Role, readonly LinkType[]> = {
  desktop: [
    "challenge",
    "authenticated",
    "connect_request",
    "connect_accept",
    "connect_reject",
    "connect_cancel",
    "invitation",
    "forget",
  ],
  phone: [
    "auth",
    "connect_request",
    "connect_accept",
    "connect_reject",
    "connect_cancel",
    "forget",
  ],
};

export type LinkMessage = { v: 1 } & (
  | { type: "challenge"; nonce: string }
  | { type: "auth"; key: string; nonce: string; signature: string }
  | { type: "authenticated" | "forget" }
  | { type: "connect_request"; requestId: string; direction: Direction }
  | {
      type: "connect_accept" | "connect_reject" | "connect_cancel";
      requestId: string;
    }
  | { type: "invitation"; requestId: string; invitation: string }
);

export function parseLinkMessage(text: string, from: Role): LinkMessage {
  const value = parseBounded(text);
  const type = value.type as LinkType;
  const extra = Object.prototype.hasOwnProperty.call(LINK_FIELDS, type)
    ? LINK_FIELDS[type]
    : undefined;
  if (
    !extra ||
    !LINK_ROUTES[from].includes(type) ||
    !exact(value, ["v", "type", ...extra]) ||
    !extra.every((key) => fieldValid[key]!(value[key]))
  )
    throw new Error("Invalid remembered-link message.");
  return value as unknown as LinkMessage;
}

/** Remembered endpoints are LAN only: private or link-local IPv4. Overlay (100.64/10) stays pairing-only. */
export function parseRememberedAddress(address: string): string {
  const endpoint = parseDesktopAddress(address);
  const [a, b] = endpoint.split(".").map(Number) as [number, number];
  if (a === 100 && b >= 64 && b <= 127)
    throw new Error(
      "Remembered PCs connect over the local network only. Pair with a code to use a VPN address.",
    );
  return endpoint;
}

export type RememberedRecord = {
  instance: unknown;
  hosts: unknown;
  port: unknown;
  txt: unknown;
};

/** A remembered endpoint seen on the LAN. Untrusted: only a TLS pin and signature make it a known PC. */
export type RememberedCandidate = { id: string; name: string; address: string };

const rememberedInstance = /^DuoDeskR-[0-9a-f]{8}$/;

export function parseRememberedRecord(
  value: RememberedRecord,
): RememberedCandidate | null {
  const { instance, hosts, port, txt } = value ?? {};
  if (typeof instance !== "string" || !rememberedInstance.test(instance))
    return null;
  if (!record(txt)) return null;
  if (txt.v !== "1" || txt.role !== "desktop") return null;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    return null;
  if (!Array.isArray(hosts)) return null;
  for (const host of hosts.slice(0, 8)) {
    if (typeof host !== "string") continue;
    try {
      return {
        id: instance,
        name: deviceName(txt.name) ?? "DuoDesk PC",
        address: parseRememberedAddress(`${host}:${port as number}`),
      };
    } catch {
      // Try the next address.
    }
  }
  return null;
}

/** Endpoints to try for one remembered PC: last good address first, then fresh adverts. Bounded. */
export function rememberedCandidates(
  hint: string | undefined,
  manual: string | undefined,
  adverts: readonly RememberedCandidate[],
  limit = 8,
): string[] {
  const list: string[] = [];
  for (const address of [manual, hint, ...adverts.map((a) => a.address)]) {
    if (!address) continue;
    try {
      const clean = parseRememberedAddress(address);
      if (!list.includes(clean)) list.push(clean);
    } catch {
      // Ignore unusable hints.
    }
  }
  return list.slice(0, limit);
}

/** A remembered peer as the local app shows it. `id` is a local record ID, never sent on the network. */
export interface RememberedDevice {
  id: string;
  name: string;
  createdAt: number;
  /** Desktop: the phone holds an authenticated idle link. Phone: this app holds one to the PC. */
  available: boolean;
  /** Phone only: last address that authenticated. A hint, not trust. */
  address?: string;
}

/** Progress of the one enrollment a session can run. */
export type EnrollState =
  | "unavailable"
  | "capable"
  | "requested"
  | "incoming"
  | "verifying"
  | "saved"
  | "cancelled"
  | "failed";

export interface EnrollStatus {
  sessionId: string;
  state: EnrollState;
  /** Display name the other device suggested for itself. */
  peerName?: string;
  message?: string;
}

export interface ConnectRequestEvent {
  deviceId: string;
  requestId: string;
  direction: Direction;
}
