import { useEffect, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import * as sender from "../../../modules/test-video";
import { createNearbyController, type NearbyState } from "./nearby-controller";

const needsPermission = () =>
  Platform.OS === "android" && Number(Platform.Version) >= 37;

/**
 * Browses for nearby PCs while `active` and the app is in the foreground.
 * `guardPrompt` keeps the permission dialog from cancelling other work.
 */
export function useNearby(
  active: boolean,
  guardPrompt: <T>(request: () => Promise<T>) => Promise<T>,
) {
  const [state, setState] = useState<NearbyState>({
    status: "idle",
    devices: [],
  });
  const [controller] = useState(() =>
    createNearbyController(
      {
        supported: sender.supportsNearby,
        hasPermission: async () =>
          !needsPermission() ||
          PermissionsAndroid.check(
            PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
          ),
        requestPermission: async () =>
          !needsPermission() ||
          (await guardPrompt(() =>
            PermissionsAndroid.request(
              PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
            ),
          )) === PermissionsAndroid.RESULTS.GRANTED,
        start: sender.nearbyStart,
        stop: sender.nearbyStop,
        subscribe: sender.subscribeNearby,
      },
      setState,
    ),
  );

  useEffect(() => {
    if (!active) return;
    if (AppState.currentState === "active") void controller.begin();
    // The native side stops browsing in the background; resume on return.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void controller.begin();
      else if (next === "background") controller.end();
    });
    return () => {
      sub.remove();
      controller.end();
    };
  }, [active, controller]);

  return { ...state, retry: () => void controller.retry() };
}

export type Nearby = ReturnType<typeof useNearby>;
