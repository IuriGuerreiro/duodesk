import type { SavedDesktop, SenderStatus } from "./types";

export type {
  SavedDesktop,
  AudioState,
  SenderStatus,
  SenderStats,
  StreamMode,
} from "./types";

export const available = false;
export const supportsScreenSharing = false;
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
