import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { StreamSettings } from "@duodesk/protocol";
import type { SenderStatus, ViewerStatus } from "./types";

export type {
  AudioState,
  ControlStatus,
  SenderStatus,
  SenderStats,
  StreamMode,
  ViewerStats,
  ViewerStatus,
} from "./types";

export const available = false;
export const supportsScreenSharing = false;
export const supportsViewing = false;
export const StreamViewerView: ComponentType<ViewProps> = () => null;
export const supportsPlaybackAudio = false;
export const supportsRemoteControl = false;

const unsupported = async (): Promise<void> => {
  throw new Error(
    "Test streaming requires an Android or iOS development build.",
  );
};

export const connect = (_invitation: string): Promise<void> => unsupported();
export const start = (_bitrateMbps: number): Promise<void> => unsupported();
export const startScreen = (
  _bitrateMbps: number,
  _shareAudio: boolean,
  _settings: StreamSettings,
): Promise<void> => unsupported();
export const isControlServiceEnabled = async (): Promise<boolean> => false;
export const allowControl = (): Promise<void> => unsupported();
export const revokeControl = async (): Promise<void> => {};
export const openAccessibilitySettings = (): Promise<void> => unsupported();
export const pause = async (): Promise<void> => {};
export const reconnect = (): Promise<void> => unsupported();
export const stop = async (): Promise<void> => {};
export const background = async (): Promise<void> => {};
export const getStatus = async (): Promise<SenderStatus> => ({
  state: "idle",
});
export const subscribe = (
  _listener: (status: SenderStatus) => void,
): { remove(): void } => ({
  remove() {},
});

export const pairRequest = async (
  _address: string,
  _message: string,
  _fresh: boolean,
): Promise<string> => {
  await unsupported();
  return "";
};
export const pairClose = async (): Promise<void> => {};

export const watch = (_invitation: string): Promise<void> => unsupported();
export const stopWatching = async (): Promise<void> => {};
export const enterViewerMode = async (): Promise<void> => {};
export const exitViewerMode = async (): Promise<void> => {};
export const getViewerStatus = async (): Promise<ViewerStatus> => ({
  state: "idle",
});
export const subscribeViewer = (
  _listener: (status: ViewerStatus) => void,
): { remove(): void } => ({
  remove() {},
});
export type NearbyEvent = Record<string, unknown>;
export const supportsNearby = false;
export const nearbyStart = (): Promise<void> => unsupported();
export const nearbyStop = async (): Promise<void> => {};
export const subscribeNearby = (
  _listener: (event: NearbyEvent) => void,
): { remove(): void } => ({ remove() {} });

export const supportsRemembered = false;
export const trustCommand = async (
  _method: string,
  _args: Record<string, unknown> = {},
): Promise<unknown> => unsupported();
export const subscribeTrust =
  (_listener: (event: Record<string, unknown>) => void): (() => void) =>
  () => {};
