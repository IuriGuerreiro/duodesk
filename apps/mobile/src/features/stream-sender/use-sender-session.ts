import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Keyboard, PermissionsAndroid, Platform } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { parseInvitation } from "@duodesk/protocol";
import { parsePairingQrPayload } from "@duodesk/protocol/pairing";
import {
  holdInvitation,
  pairWithCode,
  type PairingMode,
} from "@/features/pairing";
import * as sender from "../../../modules/test-video";
import type { SenderStatus } from "../../../modules/test-video";

type Operation = "connect" | "start" | "screen" | "stop" | null;

async function localNetworkPermission() {
  if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
    );
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new Error("Allow local network access to connect to your PC.");
    }
  }
}

function parseBitrate(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 2 || value > 30) {
    throw new Error("Choose a whole number from 2 to 30 Mbps.");
  }
  return value;
}

export function useSenderSession() {
  const router = useRouter();
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [operation, setOperation] = useState<Operation>(null);
  const [mode, setMode] = useState<PairingMode>("closed");
  const [address, setAddressValue] = useState("");
  const [code, setCodeValue] = useState("");
  const [notice, setNotice] = useState("");
  const [receiver, setReceiver] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState("12");
  const [error, setError] = useState("");
  const [intent, setIntent] = useState<"connect" | "start" | "screen">(
    "connect",
  );
  const locked = useRef<Operation>(null);
  const requestId = useRef(0);
  const active = useRef(true);
  const generation = useRef(0);
  const scanning = useRef(false);
  const statusRef = useRef<SenderStatus>(status);
  const eventSeq = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const closeScanner = useCallback(() => {
    scanning.current = false;
    setMode("closed");
  }, []);

  const syncStatus = useCallback(async () => {
    if (!sender.available) return;
    const seqAtCall = eventSeq.current;
    try {
      const snapshot = await sender.getStatus();
      if (active.current && eventSeq.current === seqAtCall) {
        setStatus(snapshot);
      }
    } catch {
      // Keep the last known status when the query fails.
    }
  }, []);

  // Leaving the screen ends pairing and previews, but an active screen share
  // keeps running so it can continue while other apps are open.
  const leaveScreen = useCallback(() => {
    generation.current += 1;
    closeScanner();
    void sender.pairClose();
    const current = statusRef.current;
    if (current.mode !== "screen" || current.state !== "streaming") {
      void sender.background();
    }
  }, [closeScanner]);

  useEffect(() => {
    active.current = true;
    const subscription = sender.subscribe((next) => {
      if (!active.current) return;
      eventSeq.current += 1;
      setStatus(next);
      if (next.state === "failed" || next.state === "stopped") {
        setReceiver(null);
        closeScanner();
      }
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void syncStatus();
      } else if (next === "background") {
        generation.current += 1;
        closeScanner();
        void sender.pairClose();
        void sender.background();
      }
    });
    return () => {
      active.current = false;
      subscription.remove();
      appState.remove();
      leaveScreen();
    };
  }, [closeScanner, leaveScreen, syncStatus]);

  useFocusEffect(
    useCallback(() => {
      void syncStatus();
      return leaveScreen;
    }, [leaveScreen, syncStatus]),
  );

  const canPair =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const busy = operation !== null || status.state === "connecting";
  const canSubmit = address.trim().length > 0 && /^[0-9]{6}$/.test(code);

  async function run(
    kind: Exclude<Operation, null>,
    action: (epoch: number) => Promise<void>,
  ) {
    if (locked.current === "stop" || (locked.current && kind !== "stop"))
      return;
    locked.current = kind;
    const currentRequest = ++requestId.current;
    const epoch = generation.current;
    setOperation(kind);
    setError("");
    try {
      await action(epoch);
    } catch (cause) {
      if (active.current && generation.current === epoch) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Something went wrong. Try again.",
        );
      }
    } finally {
      if (requestId.current === currentRequest) {
        locked.current = null;
        if (active.current) setOperation(null);
      }
    }
  }

  function setAddress(value: string) {
    setAddressValue(value);
    setNotice("");
  }

  function setCode(value: string) {
    setCodeValue(value.replace(/[^0-9]/g, "").slice(0, 6));
    setNotice("");
  }

  function connect() {
    if (!canPair || !sender.available || !canSubmit) return;
    Keyboard.dismiss();
    void run("connect", async (epoch) => {
      const target = address.trim();
      const cancelled = () => !active.current || generation.current !== epoch;
      await localNetworkPermission();
      if (cancelled()) return;
      closeScanner();
      const invitation = await pairWithCode(target, code, cancelled);
      if (cancelled()) return;
      setCodeValue("");
      // The desktop chose the direction when it made the code, so route by it.
      if (parseInvitation(invitation).direction === "desktop-to-phone") {
        if (!sender.supportsViewing)
          throw new Error(
            "Watching your PC screen needs the Android app with the latest build.",
          );
        holdInvitation(invitation);
        router.push("/watch");
        return;
      }
      setIntent("connect");
      setReceiver(target);
      await sender.connect(invitation);
    });
  }

  function acceptScan(text: string) {
    if (!scanning.current) return;
    try {
      const pairing = parsePairingQrPayload(text);
      scanning.current = false;
      setAddressValue(pairing.address);
      setCodeValue(pairing.code);
      setError("");
      setNotice("Address and code filled in. Tap Connect to continue.");
      setMode("manual");
    } catch {
      setError(
        "That QR code is not a current DuoDesk code. Scan a new one from your PC.",
      );
    }
  }

  function openScanner() {
    scanning.current = true;
    setError("");
    setNotice("");
    setMode("scan");
  }

  function start() {
    if (status.state !== "ready") return;
    Keyboard.dismiss();
    void run("start", async () => {
      const value = parseBitrate(bitrate);
      setIntent("start");
      await sender.start(value);
    });
  }

  function startScreen() {
    if (status.state !== "ready" || !sender.supportsScreenSharing) return;
    Keyboard.dismiss();
    void run("screen", async () => {
      const value = parseBitrate(bitrate);
      if (Platform.OS === "android" && Number(Platform.Version) >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
      }
      setIntent("screen");
      await sender.startScreen(value);
    });
  }

  function stop() {
    if (locked.current === "stop") return;
    generation.current += 1;
    void run("stop", async () => {
      closeScanner();
      void sender.pairClose();
      await sender.stop();
    });
  }

  return {
    status,
    operation,
    mode,
    setMode,
    address,
    setAddress,
    code,
    setCode,
    canSubmit,
    notice,
    receiver,
    bitrate,
    setBitrate,
    error,
    setError,
    canPair,
    busy,
    available: sender.available,
    supportsScreenSharing: sender.supportsScreenSharing,
    negotiatingVideo: status.state === "connecting" && intent !== "connect",
    screenIntent: intent === "screen",
    connect,
    start,
    startScreen,
    stop,
    acceptScan,
    openScanner,
    closeScanner,
  };
}
