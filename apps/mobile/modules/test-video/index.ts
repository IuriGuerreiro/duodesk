import type { SenderStatus } from "./types";
export type { SenderStatus, SenderStats } from "./types";
export const available = false;
const unsupported = async (): Promise<void> => {
  throw new Error(
    "Test streaming requires an Android or iOS development build.",
  );
};
export const connect = (_invitation: string): Promise<void> => unsupported();
export const start = (_bitrateMbps: number): Promise<void> => unsupported();
export const pause = async (): Promise<void> => {};
export const stop = async (): Promise<void> => {};
export const subscribe = (_listener: (status: SenderStatus) => void) => ({
  remove() {},
});
