import { exact, hex, id, record } from "./stream/guards.ts";
import { parseInvitation, type Invitation } from "./stream/invitation.ts";

export const TRUST_RECONNECT_PORT = 42889;
export const TRUST_PROOF_PREFIX = "DuoDesk trusted reconnect v1\n";
export type TrustedPhone = {
  phoneId: string;
  name: string;
  publicKey: string;
  createdAt: number;
};
export type PendingTrust = Omit<TrustedPhone, "createdAt"> & {
  requestId: string;
};
export type TrustStatus = {
  available: boolean;
  reason: string | null;
  enabled: boolean;
  address: string | null;
  fingerprint: string | null;
  devices: TrustedPhone[];
  pending: PendingTrust[];
};
export type TrustEnrollment = {
  v: 1;
  sessionId: string;
  type: "trust_enroll";
  phoneId: string;
  name: string;
  publicKey: string;
};
export type TrustCommit = {
  v: 1;
  sessionId: string;
  type: "trust_committed";
  phoneId: string;
  fingerprint: string;
  address: string;
};
export type TrustRejection = {
  v: 1;
  sessionId: string;
  type: "trust_rejected";
  phoneId: string;
  reason: string;
};
export type TrustSignal = TrustEnrollment | TrustCommit | TrustRejection;
export type TrustConnect = { v: 1; type: "trust_connect"; phoneId: string };
export type TrustChallenge = {
  v: 1;
  type: "trust_challenge";
  phoneId: string;
  fingerprint: string;
  nonce: string;
};
export type TrustProof = {
  v: 1;
  type: "trust_proof";
  phoneId: string;
  signature: string;
};
export type TrustInvitation = {
  v: 1;
  type: "trust_invitation";
  invitation: Invitation;
};
export type TrustReconnectMessage =
  TrustConnect | TrustChallenge | TrustProof | TrustInvitation;
export type TrustEvent =
  | { kind: "trust_status"; status: TrustStatus }
  | { kind: "trust_enrollment"; request: PendingTrust }
  | { kind: "trust_reconnected"; phoneId: string; invitation: Invitation };

function boundedJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > 4096)
    throw new Error("Trust message is too large.");
  return JSON.parse(text);
}
function address(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)
  )
    return false;
  const [ip, port] = value.split(":");
  return (
    ip !== undefined &&
    ip.split(".").every((n) => Number(n) <= 255) &&
    Number(port) >= 1 &&
    Number(port) <= 65535
  );
}
export function parseTrustSignal(text: string, sessionId: string): TrustSignal {
  const value = boundedJson(text);
  if (
    !record(value) ||
    value.v !== 1 ||
    value.sessionId !== sessionId ||
    !id(value.sessionId) ||
    !hex(value.phoneId)
  )
    throw new Error("Invalid trust session.");
  const base = ["v", "sessionId", "type", "phoneId"];
  if (
    value.type === "trust_enroll" &&
    exact(value, [...base, "name", "publicKey"]) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    new TextEncoder().encode(value.name).length <= 80 &&
    !/\p{Cc}/u.test(value.name) &&
    typeof value.publicKey === "string" &&
    /^04[a-f0-9]{128}$/.test(value.publicKey)
  )
    return {
      v: 1,
      sessionId,
      type: value.type,
      phoneId: value.phoneId,
      name: value.name,
      publicKey: value.publicKey,
    };
  if (
    value.type === "trust_committed" &&
    exact(value, [...base, "fingerprint", "address"]) &&
    hex(value.fingerprint) &&
    address(value.address)
  )
    return {
      v: 1,
      sessionId,
      type: value.type,
      phoneId: value.phoneId,
      fingerprint: value.fingerprint,
      address: value.address,
    };
  if (
    value.type === "trust_rejected" &&
    exact(value, [...base, "reason"]) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 256
  )
    return {
      v: 1,
      sessionId,
      type: value.type,
      phoneId: value.phoneId,
      reason: value.reason,
    };
  throw new Error("Invalid trust message.");
}
export function parseTrustReconnect(
  text: string,
  now = Date.now(),
): TrustReconnectMessage {
  const value = boundedJson(text);
  if (!record(value) || value.v !== 1)
    throw new Error("Invalid trust version.");
  if (
    value.type === "trust_invitation" &&
    exact(value, ["v", "type", "invitation"])
  )
    return {
      v: 1,
      type: value.type,
      invitation: parseInvitation(JSON.stringify(value.invitation), now),
    };
  if (!hex(value.phoneId)) throw new Error("Invalid phone identity.");
  const base = ["v", "type", "phoneId"];
  if (value.type === "trust_connect" && exact(value, base))
    return { v: 1, type: value.type, phoneId: value.phoneId };
  if (
    value.type === "trust_challenge" &&
    exact(value, [...base, "fingerprint", "nonce"]) &&
    hex(value.fingerprint) &&
    hex(value.nonce)
  )
    return {
      v: 1,
      type: value.type,
      phoneId: value.phoneId,
      fingerprint: value.fingerprint,
      nonce: value.nonce,
    };
  if (
    value.type === "trust_proof" &&
    exact(value, [...base, "signature"]) &&
    typeof value.signature === "string" &&
    /^(?:[a-f0-9]{2}){8,80}$/.test(value.signature)
  )
    return {
      v: 1,
      type: value.type,
      phoneId: value.phoneId,
      signature: value.signature,
    };
  throw new Error("Invalid reconnect message.");
}
export function trustProofBytes(
  nonce: string,
  fingerprint: string,
  phoneId: string,
): Uint8Array {
  const prefix = new TextEncoder().encode(TRUST_PROOF_PREFIX);
  const result = new Uint8Array(prefix.length + 96);
  result.set(prefix);
  [nonce, fingerprint, phoneId].forEach((field, index) => {
    if (!hex(field)) throw new Error("Invalid trust proof field.");
    for (let byte = 0; byte < 32; byte++)
      result[prefix.length + index * 32 + byte] = Number.parseInt(
        field.slice(byte * 2, byte * 2 + 2),
        16,
      );
  });
  return result;
}
