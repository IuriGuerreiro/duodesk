import { NativeModule, requireOptionalNativeModule } from "expo";
import type { SenderStatus } from "./types";
export type { SenderStatus, SenderStats } from "./types";
type Events = { onStatus: (status: SenderStatus) => void };
declare class TestVideoNative extends NativeModule<Events> {
  connect(invitation: string): Promise<void>;
  start(bitrateMbps: number): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
}
const native = requireOptionalNativeModule<TestVideoNative>("DuoDeskTestVideo");
export const available = native !== null;
function module(): TestVideoNative {
  if (!native)
    throw new Error(
      "Install a new Android or iOS development build to enable test streaming.",
    );
  return native;
}
export const connect = (invitation: string) => module().connect(invitation);
export const start = (bitrateMbps: number) => module().start(bitrateMbps);
export const pause = async () => {
  await native?.pause();
};
export const stop = async () => {
  await native?.stop();
};
export const subscribe = (
  listener: (status: SenderStatus) => void,
): { remove(): void } =>
  native?.addListener("onStatus", listener) ?? { remove() {} };
