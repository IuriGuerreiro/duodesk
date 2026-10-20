import { useSyncExternalStore } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { parseInvitation } from "@duodesk/protocol";
import * as sender from "../../modules/test-video";

/** Pairing state shared by the home, scan, and paste routes. */
interface Session {
  invitation: string;
  connecting: boolean;
  error: string;
}

let session: Session = { invitation: "", connecting: false, error: "" };
const listeners = new Set<() => void>();

function update(next: Partial<Session>) {
  session = { ...session, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSession() {
  return useSyncExternalStore(subscribe, () => session);
}

export function setSessionError(error: string) {
  update({ error });
}

/** Desktop address shown while connecting, so the user knows which PC it is. */
export function hostOf(invitation: string) {
  try {
    return new URL(parseInvitation(invitation).url).hostname;
  } catch {
    return "your computer";
  }
}

export async function connectWith(invitation: string) {
  update({ invitation, connecting: true, error: "" });
  try {
    parseInvitation(invitation);
    if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
      );
      if (result !== PermissionsAndroid.RESULTS.GRANTED)
        throw new Error(
          "Allow local network access to connect to your computer.",
        );
    }
    await sender.connect(invitation);
  } catch (cause) {
    update({ error: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    update({ connecting: false });
  }
}
