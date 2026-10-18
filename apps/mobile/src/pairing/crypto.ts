// The SRP library needs only WebCrypto randomness and SHA-256, not a full crypto polyfill.
import { digest, getRandomValues, CryptoDigestAlgorithm } from "expo-crypto";
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues,
      subtle: {
        digest: (algorithm: string, data: ArrayBuffer) => {
          if (algorithm !== "SHA-256")
            throw new Error("Unsupported pairing hash.");
          return digest(CryptoDigestAlgorithm.SHA256, data);
        },
      },
    },
  });
}
