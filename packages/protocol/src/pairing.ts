import { createSRPClient, createSRPServer } from "@swan-io/srp";
import { gcm } from "@noble/ciphers/aes";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils";
import { parseInvitation, type Invitation } from "./stream/invitation.ts";

const USER = "duodesk-pair-v1";
const AAD = new TextEncoder().encode(USER);
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
export async function createPairingServer(code: string) {
  if (!isPairingCode(code)) throw new Error("Expected six digits.");
  const srp = client();
  const salt = srp.generateSalt();
  const verifier = srp.deriveVerifier(
    await srp.derivePrivateKey(salt, USER, code),
  );
  let pending:
    { requestId: string; secret: string; public: string } | undefined;
  let consumed = false;
  return async (requestId: string, text: string, invitation: Invitation) => {
    if (consumed || Date.now() >= invitation.expiresAt)
      throw new Error("Pairing expired.");
    const message = pairingMessage(text);
    if (!pending || pending.requestId !== requestId) {
      fields(message, ["v", "type", "public"]);
      if (
        message.v !== 1 ||
        message.type !== "hello" ||
        !isHex(message.public, 512)
      )
        throw new Error("Invalid hello.");
      const ephemeral = await server().generateEphemeral(verifier);
      pending = { requestId, secret: ephemeral.secret, public: message.public };
      return {
        message: JSON.stringify({
          v: 1,
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
      message.v !== 1 ||
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
    const encrypted = gcm(hexToBytes(session.key), nonce, AAD).encrypt(
      new TextEncoder().encode(JSON.stringify(invitation)),
    );
    return {
      message: JSON.stringify({
        v: 1,
        type: "verified",
        proof: session.proof,
        nonce: bytesToHex(nonce),
        encrypted: bytesToHex(encrypted),
      }),
      complete: true,
    };
  };
}
export function createPairingClient(code: string, address: string) {
  const endpoint = parseDesktopAddress(address);
  if (!isPairingCode(code)) throw new Error("Enter exactly six digits.");
  const srp = client();
  const ephemeral = srp.generateEphemeral();
  let session: { key: string; proof: string } | undefined;
  return {
    hello: JSON.stringify({ v: 1, type: "hello", public: ephemeral.public }),
    async challenge(text: string) {
      if (session) throw new Error("Repeated challenge.");
      const message = pairingMessage(text);
      fields(message, ["v", "type", "salt", "public"]);
      if (
        message.v !== 1 ||
        message.type !== "challenge" ||
        !isHex(message.salt, 64) ||
        !isHex(message.public, 512)
      )
        throw new Error("Invalid challenge.");
      const key = await srp.derivePrivateKey(message.salt, USER, code);
      session = await srp.deriveSession(
        ephemeral.secret,
        message.public,
        message.salt,
        USER,
        key,
      );
      return JSON.stringify({ v: 1, type: "proof", proof: session.proof });
    },
    async finish(text: string) {
      if (!session) throw new Error("Missing challenge.");
      const active = session;
      session = undefined;
      const message = pairingMessage(text);
      fields(message, ["v", "type", "proof", "nonce", "encrypted"]);
      if (
        message.v !== 1 ||
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
      const plain = gcm(
        hexToBytes(active.key),
        hexToBytes(message.nonce),
        AAD,
      ).decrypt(hexToBytes(message.encrypted));
      const invitation = parseInvitation(new TextDecoder().decode(plain));
      if (new URL(invitation.url).hostname !== endpoint.split(":")[0])
        throw new Error("Receiver address changed.");
      return JSON.stringify(invitation);
    },
  };
}
