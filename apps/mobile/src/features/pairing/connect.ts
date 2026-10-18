import "./crypto";
import { createPairingClient } from "@duodesk/protocol/pairing";
import * as sender from "../../../modules/test-video";

export async function pairWithCode(
  address: string,
  code: string,
  cancelled: () => boolean,
) {
  if (cancelled()) throw new Error("Pairing cancelled.");
  const client = createPairingClient(code, address);
  let stage: "address" | "code" = "address";
  try {
    const challenge = await sender.pairRequest(address, client.hello, true);
    if (cancelled()) throw new Error("Pairing cancelled.");
    stage = "code";
    const proof = await client.challenge(challenge);
    if (cancelled()) throw new Error("Pairing cancelled.");
    const response = await sender.pairRequest(address, proof, false);
    const invitation = await client.finish(response);
    if (cancelled()) throw new Error("Pairing cancelled.");
    return invitation;
  } catch (cause) {
    if (cancelled()) throw new Error("Pairing cancelled.");
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      stage === "address"
        ? `Cannot reach the desktop. Check its address and port, keep the receiver open, and allow DuoDesk through the firewall. Use the same Wi-Fi/router; guest Wi-Fi or a VPN may block access. Details: ${detail}`
        : "Code verification failed. Check all six digits. If the code expired, was used, or reached its attempt limit, create a new code on the desktop.",
    );
  } finally {
    await sender.pairClose();
  }
}
