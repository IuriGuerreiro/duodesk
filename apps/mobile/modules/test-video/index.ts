import type { ComponentType } from "react";
import type { ViewProps } from "react-native";
import type { SenderStatus, ViewerStatus } from "./types";

export type {
  AudioState,
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
