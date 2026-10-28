import { createSRPClient, createSRPServer } from "@swan-io/srp";
import { gcm } from "@noble/ciphers/aes";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils";
import { parseInvitation, type Invitation } from "./stream/invitation.ts";

const USER = "duodesk-pair-v1";
const AAD = new TextEncoder().encode(USER);
/** v2 only adds authenticated feature negotiation; SRP identity and invitation are unchanged. */
const AAD_V2 = new TextEncoder().encode("duodesk-pair-v2");
/** Optional extensions a v2 peer may offer. Unknown names are ignored, never errors. */
export const PAIRING_FEATURES = ["trust-v1"] as const;
const MAX_FEATURES = 8;
const isFeatureList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_FEATURES &&
  value.every((f) => typeof f === "string" && /^[a-z0-9-]{1,32}$/.test(f)) &&
  new Set(value).size === value.length;
const client = () => createSRPClient("SHA-256", 2048);
const server = () => createSRPServer("SHA-256", 2048);
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const pairingQrPrefix = "duodesk-pair://connect";
const isPairingCode = (value: unknown): value is string =>
  typeof value === "string" && value.length === 6 && /^[0-9]{6}$/.test(value);
const isHex = (v: unknown, size: number): v is string =>
  typeof v === "string" && v.length === size && /^[0-9a-f]+$/.test(v);
function fields(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))
  )
    throw new Error("Invalid pairing message.");
}
export function pairingMessage(text: string): unknown {
  if (text.length > 8192) throw new Error("Pairing message too large.");
  return JSON.parse(text);
}
export function parseDesktopAddress(address: string): string {
  // Literal private/link-local IPv4 only. No DNS, credentials, paths, public IPs or redirects.
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(
    address,
  );
  if (!match)
    throw new Error(
      "Enter the desktop address and port, for example 192.168.1.20:39871.",
    );
  const [a, b, c, d, port] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    [a, b, c, d].some((n) => n > 255) ||
    port < 1 ||
    port > 65535 ||
    !(
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT space, used by Tailscale and similar private overlays.
      (a === 100 && b >= 64 && b <= 127)
    )
  )
    throw new Error("Use a private local-network IPv4 address.");
  const normalized = `${a}.${b}.${c}.${d}:${port}`;
  if (normalized !== address)
    throw new Error("Use the address exactly as shown on the desktop.");
  return normalized;
}
export function createPairingQrPayload(address: string, code: string): string {
  const endpoint = parseDesktopAddress(address);
  if (!isPairingCode(code)) throw new Error("Expected six digits.");
  return `${pairingQrPrefix}?v=1&address=${encodeURIComponent(endpoint)}&code=${code}`;
}
export function parsePairingQrPayload(text: string): {
  address: string;
  code: string;
} {
  try {
    if (typeof text !== "string" || text.length > 256)
      throw new Error("Invalid QR length.");
    const prefix = `${pairingQrPrefix}?v=1&address=`;
    const codeMarker = "&code=";
    const addressStart = prefix.length;
    const codeStart = text.indexOf(codeMarker, addressStart);
    if (
      !text.startsWith(prefix) ||
      codeStart < addressStart ||
      text.indexOf(codeMarker, codeStart + codeMarker.length) !== -1
    )
      throw new Error("Invalid QR fields.");
    const encodedAddress = text.slice(addressStart, codeStart);
    const address = parseDesktopAddress(decodeURIComponent(encodedAddress));
    const code = text.slice(codeStart + codeMarker.length);
    if (!isPairingCode(code)) throw new Error("Invalid QR code.");
    if (createPairingQrPayload(address, code) !== text)
      throw new Error("Non-canonical QR.");
    return { address, code };
  } catch {
    throw new Error(
      "This is not a valid DuoDesk pairing QR. Scan the code shown on the desktop, or enter its address and six-digit code.",
    );
  }
}
export function verificationCode(): string {
  // Rejection sampling avoids modulo bias. This is independent of the invitation token.
  let n: number;
  do {
    n = new DataView(random(4).buffer).getUint32(0);
  } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, "0");
}
export async function createPairingServer(
  code: string,
  options: { features?: readonly string[] } = {},
) {
  if (!isPairingCode(code)) throw new Error("Expected six digits.");
  const offered = options.features ?? [];
  const srp = client();
  const salt = srp.generateSalt();
  const verifier = srp.deriveVerifier(
    await srp.derivePrivateKey(salt, USER, code),
  );
  let pending:
    | {
        requestId: string;
        secret: string;
        public: string;
        version: 1 | 2;
        features: string[];
      }
    | undefined;
  let consumed = false;
  return async (requestId: string, text: string, invitation: Invitation) => {
    if (consumed || Date.now() >= invitation.expiresAt)
      throw new Error("Pairing expired.");
    const message = pairingMessage(text);
    if (!pending || pending.requestId !== requestId) {
      const v2 =
        !!message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).v === 2;
      fields(
        message,
        v2 ? ["v", "type", "public", "features"] : ["v", "type", "public"],
      );
      if (
        message.v !== (v2 ? 2 : 1) ||
        message.type !== "hello" ||
        !isHex(message.public, 512) ||
        (v2 && !isFeatureList(message.features))
      )
        throw new Error("Invalid hello.");
      const requested = v2 ? (message.features as string[]) : [];
      const ephemeral = await server().generateEphemeral(verifier);
      pending = {
        requestId,
        secret: ephemeral.secret,
        public: message.public,
        version: v2 ? 2 : 1,
        features: offered.filter((f) => requested.includes(f)),
      };
      return {
        message: JSON.stringify({
          v: pending.version,
          type: "challenge",
          salt,
          public: ephemeral.public,
        }),
        complete: false,
      };
    }
    const active = pending;
    pending = undefined;
    fields(message, ["v", "type", "proof"]);
    if (
      message.v !== active.version ||
      message.type !== "proof" ||
      !isHex(message.proof, 64)
    )
      throw new Error("Invalid proof.");
    const session = await server().deriveSession(
      active.secret,
      active.public,
      salt,
      USER,
      verifier,
      message.proof,
    );
    if (consumed || Date.now() >= invitation.expiresAt)
      throw new Error("Pairing expired.");
    consumed = true;
    const nonce = random(12);
    const plain =
      active.version === 2
        ? JSON.stringify({ invitation, features: active.features })
        : JSON.stringify(invitation);
    const encrypted = gcm(
      hexToBytes(session.key),
      nonce,
      active.version === 2 ? AAD_V2 : AAD,
    ).encrypt(new TextEncoder().encode(plain));
    return {
      message: JSON.stringify({
        v: active.version,
        type: "verified",
        proof: session.proof,
        nonce: bytesToHex(nonce),
        encrypted: bytesToHex(encrypted),
      }),
      complete: true,
    };
  };
}
/**
 * `features` selects the v2 hello. A desktop that predates v2 closes the socket
 * on it; the caller may then retry v1 on a new connection, but only before a
 * valid v2 challenge arrived (see `challenged`).
 */
export function createPairingClient(
  code: string,
  address: string,
  options: { features?: readonly string[] } = {},
) {
  const endpoint = parseDesktopAddress(address);
  if (!isPairingCode(code)) throw new Error("Enter exactly six digits.");
  const requested = options.features ? [...options.features] : undefined;
  if (requested && !isFeatureList(requested))
    throw new Error("Invalid pairing features.");
  const version = requested ? 2 : 1;
  const srp = client();
  const ephemeral = srp.generateEphemeral();
  let session: { key: string; proof: string } | undefined;
  let challenged = false;
  let negotiated: string[] = [];
  return {
    version,
    hello: JSON.stringify(
      requested
        ? { v: 2, type: "hello", public: ephemeral.public, features: requested }
        : { v: 1, type: "hello", public: ephemeral.public },
    ),
    /** True once a well-formed challenge for this version was accepted. */
    get challenged() {
      return challenged;
    },
    /** Features the desktop authenticated inside the encrypted v2 response. */
    get features(): readonly string[] {
      return negotiated;
    },
    async challenge(text: string) {
      if (session) throw new Error("Repeated challenge.");
      const message = pairingMessage(text);
      fields(message, ["v", "type", "salt", "public"]);
      if (
        message.v !== version ||
        message.type !== "challenge" ||
        !isHex(message.salt, 64) ||
        !isHex(message.public, 512)
      )
        throw new Error("Invalid challenge.");
      challenged = true;
      const key = await srp.derivePrivateKey(message.salt, USER, code);
      session = await srp.deriveSession(
        ephemeral.secret,
        message.public,
        message.salt,
        USER,
        key,
      );
      return JSON.stringify({
        v: version,
        type: "proof",
        proof: session.proof,
      });
    },
    async finish(text: string) {
      if (!session) throw new Error("Missing challenge.");
      const active = session;
      session = undefined;
      const message = pairingMessage(text);
      fields(message, ["v", "type", "proof", "nonce", "encrypted"]);
      if (
        message.v !== version ||
        message.type !== "verified" ||
        !isHex(message.proof, 64) ||
        !isHex(message.nonce, 24) ||
        typeof message.encrypted !== "string" ||
        message.encrypted.length < 32 ||
        message.encrypted.length > 4096 ||
        !/^(?:[a-f0-9]{2})+$/.test(message.encrypted)
      )
        throw new Error("Invalid verification.");
      await srp.verifySession(ephemeral.public, active, message.proof);
      const plain = new TextDecoder().decode(
        gcm(
          hexToBytes(active.key),
          hexToBytes(message.nonce),
          version === 2 ? AAD_V2 : AAD,
        ).decrypt(hexToBytes(message.encrypted)),
      );
      let invitationText = plain;
      let features: string[] = [];
      if (version === 2) {
        const envelope: unknown = JSON.parse(plain);
        fields(envelope, ["invitation", "features"]);
        if (
          !isFeatureList(envelope.features) ||
          !envelope.features.every((f) => requested?.includes(f))
        )
          throw new Error("Invalid features.");
        invitationText = JSON.stringify(envelope.invitation);
        features = envelope.features;
      }
      const invitation = parseInvitation(invitationText);
      if (new URL(invitation.url).hostname !== endpoint.split(":")[0])
        throw new Error("Receiver address changed.");
      negotiated = features;
      return JSON.stringify(invitation);
    },
  };
}
