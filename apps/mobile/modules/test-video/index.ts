import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { SenderStatus, ViewerStatus } from "./types";
import type { SavedDesktop } from "./types";

export type {
  SavedDesktop,
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
): Promise<void> => unsupported();
export const isControlServiceEnabled = async (): Promise<boolean> => false;
export const allowControl = (): Promise<void> => unsupported();
export const revokeControl = async (): Promise<void> => {};
export const openAccessibilitySettings = (): Promise<void> => unsupported();
export const pause = async (): Promise<void> => {};
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

export const supportsTrustedDevices = false;
export const connectAndRemember = (
  _invitation: string,
  _name: string,
): Promise<void> => unsupported();
export const listTrustedDesktops = async (): Promise<SavedDesktop[]> => [];
export const updateTrustedAddress = (
  _fingerprint: string,
  _address: string,
): Promise<void> => unsupported();
export const forgetTrustedDesktop = (_fingerprint: string): Promise<void> =>
  unsupported();
export const reconnectTrusted = async (
  _fingerprint: string,
): Promise<string> => {
  await unsupported();
  return "";
};
export const cancelTrusted = async (): Promise<void> => {};
export const watch = (_invitation: string): Promise<void> => unsupported();
export const stopWatching = async (): Promise<void> => {};
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
