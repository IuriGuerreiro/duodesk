export type ConnectFlow = {
  /** System prompt (for example Android local network access). Throws if denied. */
  requestLocalNetwork: () => Promise<void>;
  /** Verifies the code with the desktop and returns its invitation. */
  pair: (
    address: string,
    code: string,
    cancelled: () => boolean,
  ) => Promise<string>;
  /** Hands the invitation to the native sender. */
  connect: (invitation: string) => Promise<void>;
};

/**
 * Shared by manual entry and QR scans: ask for permission, verify the code,
 * then connect. Stops quietly as soon as the caller reports cancellation, so
 * stale work never reaches the sender. `onPaired` runs once, only if the
 * attempt is still current.
 */
export async function connectToDesktop(
  flow: ConnectFlow,
  request: {
    address: string;
    code: string;
    cancelled: () => boolean;
    onPaired: () => void;
  },
) {
  const { address, code, cancelled, onPaired } = request;
  await flow.requestLocalNetwork();
  if (cancelled()) return;
  const invitation = await flow.pair(address, code, cancelled);
  if (cancelled()) return;
  onPaired();
  await flow.connect(invitation);
}
