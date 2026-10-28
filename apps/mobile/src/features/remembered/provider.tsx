import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, AppState, PermissionsAndroid, Platform } from "react-native";
import * as native from "../../../modules/test-video";
import { useSenderConnection } from "@/features/stream-sender";

export interface RememberedDevice {
  id: string;
  name: string;
  address: string;
  available: boolean;
}
interface Status {
  available: boolean;
  error?: string;
  devices: RememberedDevice[];
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function statusValue(v: unknown): Status {
  if (
    !record(v) ||
    typeof v.available !== "boolean" ||
    !Array.isArray(v.devices)
  )
    throw new Error("Invalid native trust status");
  const devices = v.devices.map((d: unknown) => {
    if (
      !record(d) ||
      typeof d.id !== "string" ||
      typeof d.name !== "string" ||
      typeof d.address !== "string" ||
      typeof d.available !== "boolean"
    )
      throw new Error("Invalid native device");
    return {
      id: d.id,
      name: d.name,
      address: d.address,
      available: d.available,
    };
  });
  return {
    available: v.available,
    error: typeof v.error === "string" ? v.error : undefined,
    devices,
  };
}
const Context = createContext<
  | {
      status: Status;
      error: string;
      enroll: string;
      busy: boolean;
      pendingRequest?: string;
      command: (
        method: string,
        args?: Record<string, unknown>,
      ) => Promise<boolean>;
      refresh: () => Promise<void>;
    }
  | undefined
>(undefined);

export function RememberedProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({
    available: false,
    devices: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<string>();
  const [enroll, setEnroll] = useState("");
  const connection = useSenderConnection();
  const connect = useRef(connection.connectRemembered);
  useEffect(() => {
    connect.current = connection.connectRemembered;
  }, [connection.connectRemembered]);
  const refresh = useCallback(async () => {
    if (!native.supportsRemembered) return;
    try {
      setStatus(statusValue(await native.trustCommand("status")));
    } catch (e) {
      setError(String(e));
    }
  }, []);
  const command = useCallback(
    async (method: string, args: Record<string, unknown> = {}) => {
      setBusy(true);
      setError("");
      try {
        const result = await native.trustCommand(method, args);
        if (
          method === "connect" &&
          record(result) &&
          typeof result.requestId === "string"
        )
          setPendingRequest(result.requestId);
        if (
          method === "cancel" ||
          (method === "foreground" && args.active === false)
        )
          setPendingRequest(undefined);
        await refresh();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!native.supportsRemembered) return;
    let live = true;
    async function foreground(active: boolean) {
      if (
        active &&
        Platform.OS === "android" &&
        Number(Platform.Version) >= 37 &&
        !(await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
        ))
      )
        return;
      if (live) await command("foreground", { active });
    }
    void Promise.resolve().then(() => {
      if (live) {
        void refresh();
        void foreground(AppState.currentState === "active");
      }
    });
    const sub = AppState.addEventListener(
      "change",
      (state) => void foreground(state === "active"),
    );
    const off = native.subscribeTrust((event) => {
      if (!live) return;
      if (event.type === "status") {
        void refresh();
        return;
      }
      if (event.type === "error") {
        setError(
          typeof event.message === "string"
            ? event.message
            : "Remembered connection failed.",
        );
        return;
      }
      if (event.type === "enroll") {
        if (typeof event.state !== "string") return;
        setEnroll(event.state);
        if (event.state === "incoming")
          Alert.alert(
            "Remember this PC?",
            `${typeof event.peerName === "string" ? event.peerName : "The paired PC"} wants to remember this phone. Each session still needs approval.`,
            [
              {
                text: "Decline",
                style: "cancel",
                onPress: () => void command("enroll", { action: "reject" }),
              },
              {
                text: "Remember",
                onPress: () =>
                  void command("enroll", {
                    action: "approve",
                    name: event.peerName ?? "PC",
                  }),
              },
            ],
            { cancelable: false },
          );
        if (event.state === "saved") {
          void refresh();
          void foreground(true);
        }
      }
      if (event.type === "request" && typeof event.requestId === "string") {
        const id = event.requestId;
        if (event.direction === "desktop-to-phone" && !native.supportsViewing) {
          void command("respond", { requestId: id, accept: false });
          return;
        }
        Alert.alert(
          "New DuoDesk session",
          event.direction === "phone-to-desktop"
            ? "Your remembered PC asks to view your phone. You still choose when to start screen sharing."
            : "Your remembered PC asks to share its desktop with you.",
          [
            {
              text: "Decline",
              style: "cancel",
              onPress: () =>
                void command("respond", { requestId: id, accept: false }),
            },
            {
              text: "Accept",
              onPress: () =>
                void command("respond", { requestId: id, accept: true }),
            },
          ],
          { cancelable: false },
        );
      }
      if (event.type === "invitation" && typeof event.invitation === "string") {
        setPendingRequest(undefined);
        void connect
          .current(event.invitation)
          .catch((e) => setError(String(e)));
      }
      if (event.type === "cancelled") {
        setPendingRequest((id) => (id === event.requestId ? undefined : id));
        setError(
          "Connection request ended. Connect again when both devices are ready.",
        );
      }
    });
    return () => {
      live = false;
      sub.remove();
      off();
      void native.trustCommand("foreground", { active: false }).catch(() => {});
    };
  }, [command, refresh]);
  return (
    <Context.Provider
      value={{ status, error, enroll, busy, pendingRequest, command, refresh }}
    >
      {children}
    </Context.Provider>
  );
}
export function useRemembered() {
  const value = useContext(Context);
  if (!value) throw new Error("RememberedProvider missing");
  return value;
}
