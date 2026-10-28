import { createPairingClient } from "@duodesk/protocol/pairing";

/** A legacy desktop closes a v2 hello. Retry once, before receiving any SRP proof. */
export async function authenticatePairing(options: {
  address: string;
  code: string;
  features?: readonly string[];
  request: (
    address: string,
    message: string,
    fresh: boolean,
  ) => Promise<string>;
  close: () => Promise<void>;
  cancelled: () => boolean;
  onChallenge: () => void;
}) {
  const { address, code, cancelled } = options;
  let client = createPairingClient(
    code,
    address,
    options.features ? { features: options.features } : {},
  );
  const check = () => {
    if (cancelled()) throw new Error("Pairing cancelled.");
  };
  try {
    check();
    let challenge: string;
    try {
      challenge = await options.request(address, client.hello, true);
    } catch (error) {
      if (client.version !== 2 || client.challenged || cancelled()) throw error;
      await options.close();
      check();
      client = createPairingClient(code, address);
      challenge = await options.request(address, client.hello, true);
    }
    check();
    options.onChallenge();
    const proof = await client.challenge(challenge);
    check();
    const response = await options.request(address, proof, false);
    const invitation = await client.finish(response);
    check();
    return { invitation, features: client.features };
  } finally {
    await options.close();
  }
}
