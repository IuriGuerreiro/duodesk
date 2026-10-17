import "./crypto";
import { createPairingClient } from "@duodesk/protocol/pairing";
import * as sender from "../../modules/test-video";

export async function pairWithCode(
  address: string,
  code: string,
  cancelled: () => boolean,
) {
  if (cancelled()) throw new Error("Pairing cancelled.");
  const client = createPairingClient(code, address);
  try {
    const challenge = await sender.pairRequest(address, client.hello, true);
    if (cancelled()) throw new Error("Pairing cancelled.");
    const proof = await client.challenge(challenge);
    if (cancelled()) throw new Error("Pairing cancelled.");
    const response = await sender.pairRequest(address, proof, false);
    const invitation = await client.finish(response);
    if (cancelled()) throw new Error("Pairing cancelled.");
    return invitation;
  } finally {
    await sender.pairClose();
  }
}
