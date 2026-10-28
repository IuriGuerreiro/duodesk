import "./crypto";
import { authenticatePairing } from "./authenticate";
import * as sender from "../../../modules/test-video";

export async function pairWithCode(
  address: string,
  code: string,
  cancelled: () => boolean,
) {
  if (cancelled()) throw new Error("Pairing cancelled.");
  let stage: "address" | "code" = "address";
  try {
    const { invitation, features } = await authenticatePairing({
      address,
      code,
      cancelled,
      features: sender.supportsRemembered ? ["trust-v1"] : undefined,
      request: sender.pairRequest,
      close: sender.pairClose,
      onChallenge: () => {
        stage = "code";
      },
    });
    if (sender.supportsRemembered)
      await sender.trustCommand("prepare", {
        invitation,
        enabled: features.includes("trust-v1"),
      });
    return invitation;
  } catch (cause) {
    if (cancelled()) throw new Error("Pairing cancelled.");
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      stage === "address"
        ? `Cannot reach the desktop. Check its address and port, keep the receiver open, and allow DuoDesk through the firewall. Use the same Wi-Fi/router; guest Wi-Fi or a VPN may block access. Details: ${detail}`
        : "Code verification failed. Check all six digits. If the code expired, was used, or reached its attempt limit, create a new code on the desktop.",
    );
  }
}
