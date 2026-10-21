export function hasTrustedDevices(
  platform: string,
  native: {
    supportsTrustedDevices?: unknown;
    connectAndRemember?: unknown;
    trustedDesktops?: unknown;
    trustedAddress?: unknown;
    trustedForget?: unknown;
    trustedReconnect?: unknown;
    trustedCancel?: unknown;
  } | null,
): boolean {
  return (
    platform === "android" &&
    native?.supportsTrustedDevices === true &&
    [
      native.connectAndRemember,
      native.trustedDesktops,
      native.trustedAddress,
      native.trustedForget,
      native.trustedReconnect,
      native.trustedCancel,
    ].every((method) => typeof method === "function")
  );
}
