import { NativeModule, requireOptionalNativeModule } from "expo";
import type { SenderStatus } from "./types";

export type {
  AudioState,
  ControlStatus,
  SenderStatus,
  SenderStats,
  StreamMode,
} from "./types";

type Events = { onStatus: (status: SenderStatus) => void };

declare class TestVideoNative extends NativeModule<Events> {
  readonly supportsScreenSharing?: boolean;
  readonly supportsPlaybackAudio?: boolean;
  readonly supportsRemoteControl?: boolean;
  pairRequest(
    address: string,
    message: string,
    fresh: boolean,
  ): Promise<string>;
  pairClose(): Promise<void>;
  connect(invitation: string): Promise<void>;
  start(bitrateMbps: number): Promise<void>;
  startScreen?(bitrateMbps: number, shareAudio: boolean): Promise<void>;
  allowControl?(): Promise<void>;
  revokeControl?(): Promise<void>;
  openAccessibilitySettings?(): Promise<void>;
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

/** True on Android builds that include the gesture-only accessibility service. */
export const supportsRemoteControl: boolean = Boolean(
  native?.supportsRemoteControl,
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

const controlModule = (): TestVideoNative => {
  const mod = module();
  if (!supportsRemoteControl) {
    throw new Error(
      "Remote control requires an updated Android development build. Rebuild and install the app.",
    );
  }
  return mod;
};

/** Allows the paired PC to tap and swipe for this session only. Rejects with an explanation when it cannot start. */
export const allowControl = (): Promise<void> =>
  controlModule().allowControl!();

/** Stops accepting remote input at once. */
export const revokeControl = (): Promise<void> =>
  controlModule().revokeControl!();

/** Opens Android's Accessibility settings, where the owner turns the DuoDesk service on. */
export const openAccessibilitySettings = (): Promise<void> =>
  controlModule().openAccessibilitySettings!();

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
