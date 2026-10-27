/** Restart SDP includes its candidates, avoiding ambiguity between trickle generations on v1. */
export function gatherIce(
  peer: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearInterval(timer);
      signal.removeEventListener("abort", check);
    };
    const check = () => {
      if (signal.aborted) {
        finish();
        reject(new Error("Negotiation cancelled."));
      } else if (peer.iceGatheringState === "complete") {
        finish();
        resolve();
      }
    };
    const timer = setInterval(check, 25);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}
