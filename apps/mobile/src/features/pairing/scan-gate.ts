export type ScanResult =
  | { kind: "ignored" }
  | { kind: "pairing"; address: string; code: string }
  | { kind: "invalid"; message: string };

type ParsedPairing = { address: string; code: string };

/**
 * Turns the camera's stream of barcode events into at most one pairing
 * request. The scanner emits the same frame many times a second, so a valid
 * code disarms the gate synchronously, and an unreadable code is reported once
 * until a different payload appears.
 */
export function createScanGate(parse: (text: string) => ParsedPairing) {
  let armed = false;
  let lastInvalid: string | null = null;
  return {
    open() {
      armed = true;
      lastInvalid = null;
    },
    close() {
      armed = false;
    },
    accept(text: string): ScanResult {
      if (!armed || text === lastInvalid) return { kind: "ignored" };
      try {
        const { address, code } = parse(text);
        armed = false;
        return { kind: "pairing", address, code };
      } catch (cause) {
        lastInvalid = text;
        return {
          kind: "invalid",
          message:
            cause instanceof Error
              ? cause.message
              : "That QR code is not a DuoDesk pairing code.",
        };
      }
    },
  };
}
