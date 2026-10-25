import type { ViewerStatus } from "../../../modules/test-video/types";

export interface ViewerPlatform {
  supported: boolean;
  enterViewerMode(): Promise<void>;
  exitViewerMode(): Promise<void>;
  subscribeViewer(listener: (status: ViewerStatus) => void): { remove(): void };
  watch(invitation: string): Promise<void>;
  stopWatching(): Promise<void>;
}

/**
 * Runs one viewer screen session: landscape mode and the stream start together and are both
 * undone on close, whether the user taps Stop, presses Back, or the screen unmounts on error.
 */
export function startViewerSession(
  platform: ViewerPlatform,
  invitation: string | undefined,
  handlers: {
    onStatus(status: ViewerStatus): void;
    onError(message: string): void;
  },
): () => void {
  let closed = false;
  const subscription = platform.subscribeViewer(handlers.onStatus);
  if (platform.supported) void platform.enterViewerMode().catch(() => {});
  if (invitation) {
    platform.watch(invitation).catch((cause: unknown) => {
      if (closed) return;
      handlers.onError(
        cause instanceof Error
          ? cause.message
          : "Could not start watching. Try again.",
      );
    });
  }
  return () => {
    if (closed) return;
    closed = true;
    subscription.remove();
    void platform.stopWatching().catch(() => {});
    if (platform.supported) void platform.exitViewerMode().catch(() => {});
  };
}
