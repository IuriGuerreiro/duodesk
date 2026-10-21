import { NativeModule, requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { hasTrustedDevices } from "./trust-capability";
import type { SavedDesktop, SenderStatus } from "./types";

export type {
  SavedDesktop,
  AudioState,
  SenderStatus,
  SenderStats,
  StreamMode,
} from "./types";

type Events = { onStatus: (status: SenderStatus) => void };

declare class TestVideoNative extends NativeModule<Events> {
  readonly supportsScreenSharing?: boolean;
  readonly supportsTrustedDevices?: boolean;
  connectAndRemember?(invitation: string, name: string): Promise<void>;
  trustedDesktops?(): Promise<SavedDesktop[]>;
  trustedAddress?(fingerprint: string, address: string): Promise<void>;
  trustedForget?(fingerprint: string): Promise<void>;
  trustedReconnect?(fingerprint: string): Promise<string>;
  trustedCancel?(): Promise<void>;
  readonly supportsPlaybackAudio?: boolean;
  pairRequest(
    address: string,
    message: string,
    fresh: boolean,
  ): Promise<string>;
  pairClose(): Promise<void>;
  connect(invitation: string): Promise<void>;
  start(bitrateMbps: number): Promise<void>;
  startScreen?(bitrateMbps: number, shareAudio: boolean): Promise<void>;
  stop(): Promise<void>;
  background?(): Promise<void>;
  getStatus?(): Promise<SenderStatus>;
}

const native = requireOptionalNativeModule<TestVideoNative>("DuoDeskTestVideo");

export const available = native !== null;
export const supportsScreenSharing: boolean = Boolean(
  native?.supportsScreenSharing,
);

/** True on Android 10+ where the app can capture other apps' playback with the screen-share permission. */
export const supportsPlaybackAudio: boolean = Boolean(
  native?.supportsPlaybackAudio,
);

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

export const startScreen = async (
  bitrateMbps: number,
  shareAudio: boolean,
): Promise<void> => {
  const mod = module();
  if (!supportsScreenSharing || typeof mod.startScreen !== "function") {
    throw new Error(
      "Screen sharing requires an updated Android development build. Rebuild and install the app.",
    );
  }
  return mod.startScreen(bitrateMbps, shareAudio && supportsPlaybackAudio);
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

export const supportsTrustedDevices = hasTrustedDevices(Platform.OS, native);

function trustedModule() {
  if (
    !supportsTrustedDevices ||
    !native ||
    !native.connectAndRemember ||
    !native.trustedDesktops ||
    !native.trustedAddress ||
    !native.trustedForget ||
    !native.trustedReconnect ||
    !native.trustedCancel
  ) {
    throw new Error("Remembered desktops require an updated Android build.");
  }
  return {
    remember: native.connectAndRemember.bind(native),
    list: native.trustedDesktops.bind(native),
    address: native.trustedAddress.bind(native),
    forget: native.trustedForget.bind(native),
    reconnect: native.trustedReconnect.bind(native),
    cancel: native.trustedCancel.bind(native),
  };
}

export const connectAndRemember = (invitation: string, name: string) =>
  trustedModule().remember(invitation, name);
export const listTrustedDesktops = () => trustedModule().list();
export const updateTrustedAddress = (fingerprint: string, address: string) =>
  trustedModule().address(fingerprint, address);
export const forgetTrustedDesktop = (fingerprint: string) =>
  trustedModule().forget(fingerprint);
export const reconnectTrusted = (fingerprint: string) =>
  trustedModule().reconnect(fingerprint);
export const cancelTrusted = async () => {
  if (supportsTrustedDevices) await trustedModule().cancel();
};
