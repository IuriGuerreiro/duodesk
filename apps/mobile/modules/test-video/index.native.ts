import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import {
  NativeModule,
  requireNativeView,
  requireOptionalNativeModule,
} from "expo";
import type { SenderStatus, ViewerStatus } from "./types";

export type {
  SenderStatus,
  SenderStats,
  StreamMode,
  ViewerStats,
  ViewerStatus,
} from "./types";

type Events = {
  onStatus: (status: SenderStatus) => void;
  onViewerStatus: (status: ViewerStatus) => void;
};

declare class TestVideoNative extends NativeModule<Events> {
  readonly supportsScreenSharing?: boolean;
  readonly supportsViewing?: boolean;
  pairRequest(
    address: string,
    message: string,
    fresh: boolean,
  ): Promise<string>;
  pairClose(): Promise<void>;
  connect(invitation: string): Promise<void>;
  start(bitrateMbps: number): Promise<void>;
  startScreen?(bitrateMbps: number): Promise<void>;
  stop(): Promise<void>;
  background?(): Promise<void>;
  getStatus?(): Promise<SenderStatus>;
  watch?(invitation: string): Promise<void>;
  stopWatching?(): Promise<void>;
  getViewerStatus?(): Promise<ViewerStatus>;
}

const native = requireOptionalNativeModule<TestVideoNative>("DuoDeskTestVideo");

export const available = native !== null;
export const supportsScreenSharing: boolean = Boolean(
  native?.supportsScreenSharing,
);

export const supportsViewing: boolean = Boolean(native?.supportsViewing);

/** Draws the desktop's video natively. Only renders where `supportsViewing` is true. */
export const StreamViewerView: ComponentType<ViewProps> = supportsViewing
  ? requireNativeView<ViewProps>("DuoDeskTestVideo")
  : () => null;

let cachedStatus: SenderStatus = { state: "idle" };

function module(): TestVideoNative {
  if (!native) {
    throw new Error(
      "Install a new Android or iOS development build to enable test streaming.",
    );
  }
  return native;
}

export const connect = (invitation: string): Promise<void> =>
  module().connect(invitation);

export const start = (bitrateMbps: number): Promise<void> =>
  module().start(bitrateMbps);

export const startScreen = async (bitrateMbps: number): Promise<void> => {
  const mod = module();
  if (!supportsScreenSharing || typeof mod.startScreen !== "function") {
    throw new Error(
      "Screen sharing requires an updated Android development build. Rebuild and install the app.",
    );
  }
  return mod.startScreen(bitrateMbps);
};

export const stop = async (): Promise<void> => {
  await native?.stop();
};

export const background = async (): Promise<void> => {
  if (native && typeof native.background === "function") {
    await native.background();
  } else {
    await native?.stop();
  }
};

export const getStatus = async (): Promise<SenderStatus> => {
  if (native && typeof native.getStatus === "function") {
    try {
      const status = await native.getStatus();
      cachedStatus = status;
      return status;
    } catch {
      return cachedStatus;
    }
  }
  return cachedStatus;
};

export const subscribe = (
  listener: (status: SenderStatus) => void,
): { remove(): void } =>
  native?.addListener("onStatus", (status: SenderStatus) => {
    cachedStatus = status;
    listener(status);
  }) ?? { remove() {} };

export const pairRequest = (address: string, message: string, fresh: boolean) =>
  module().pairRequest(address, message, fresh);
export const pairClose = async () => {
  await native?.pairClose();
};

export const watch = async (invitation: string): Promise<void> => {
  const mod = module();
  if (!supportsViewing || typeof mod.watch !== "function") {
    throw new Error(
      "Watching the desktop screen requires an updated Android development build. Rebuild and install the app.",
    );
  }
  return mod.watch(invitation);
};

export const stopWatching = async (): Promise<void> => {
  if (native && typeof native.stopWatching === "function")
    await native.stopWatching();
};

export const getViewerStatus = async (): Promise<ViewerStatus> => {
  if (native && typeof native.getViewerStatus === "function")
    return native.getViewerStatus();
  return { state: "idle" };
};

export const subscribeViewer = (
  listener: (status: ViewerStatus) => void,
): { remove(): void } =>
  native?.addListener("onViewerStatus", listener) ?? { remove() {} };
