import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Keyboard, PermissionsAndroid, Platform } from "react-native";
import { useFocusEffect } from "expo-router";
import { parseInvitation } from "@duodesk/protocol";
import * as sender from "../../../modules/test-video";
import type { SenderStatus } from "../../../modules/test-video";

type Operation = "connect" | "start" | "stop" | null;
export type PairingMode = "closed" | "manual" | "scan";

export function useConnection() {
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [operation, setOperation] = useState<Operation>(null);
  const [mode, setMode] = useState<PairingMode>("closed");
  const [invitation, setInvitation] = useState("");
  const [receiver, setReceiver] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState("12");
  const [error, setError] = useState("");
  const [intent, setIntent] = useState<"connect" | "start">("connect");
  const locked = useRef<Operation>(null);
  const requestId = useRef(0);
  const active = useRef(true);
  const generation = useRef(0);
  const scanning = useRef(false);

  const closeScanner = useCallback(() => {
    scanning.current = false;
    setMode("closed");
  }, []);

  const endSession = useCallback(() => {
    generation.current += 1;
    closeScanner();
    void sender.stop().catch(() => {
      if (active.current)
        setError("Could not stop the session. Close DuoDesk to end it.");
    });
  }, [closeScanner]);

  useEffect(() => {
    active.current = true;
    const subscription = sender.subscribe((next) => {
      if (!active.current) return;
      setStatus(next);
      if (next.state === "failed" || next.state === "stopped") {
        setInvitation("");
        setReceiver(null);
        closeScanner();
      }
    });
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "background") endSession();
    });
    return () => {
      active.current = false;
      generation.current += 1;
      subscription.remove();
      appState.remove();
      void sender.stop().catch(() => {});
    };
  }, [closeScanner, endSession]);

  useFocusEffect(useCallback(() => endSession, [endSession]));

  const canPair =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const busy = operation !== null || status.state === "connecting";

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

  function connect(text = invitation) {
    if (!canPair || !sender.available) return;
    Keyboard.dismiss();
    void run("connect", async (epoch) => {
      let parsed;
      try {
        parsed = parseInvitation(text.trim());
      } catch {
        throw new Error(
          "This invitation is invalid or expired. Create a new invitation in DuoDesk on your PC.",
        );
      }
      if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
        );
        if (result !== PermissionsAndroid.RESULTS.GRANTED) {
          throw new Error("Allow local network access to connect to your PC.");
        }
      }
      // A permission prompt can outlive a blur or background transition.
      if (!active.current || generation.current !== epoch) return;
      setIntent("connect");
      setReceiver(new URL(parsed.url).hostname);
      closeScanner();
      await sender.connect(text.trim());
      if (active.current && generation.current === epoch) setInvitation("");
    });
  }

  function acceptScan(text: string) {
    if (!scanning.current) return;
    try {
      parseInvitation(text);
    } catch {
      setError(
        "That QR code is not a current DuoDesk invitation. Scan a new code from your PC.",
      );
      return;
    }
    scanning.current = false;
    connect(text);
  }

  function openScanner() {
    scanning.current = true;
    setError("");
    setMode("scan");
  }

  function start() {
    if (status.state !== "ready") return;
    Keyboard.dismiss();
    void run("start", async () => {
      const value = Number(bitrate);
      if (!Number.isInteger(value) || value < 2 || value > 30) {
        throw new Error("Choose a whole number from 2 to 30 Mbps.");
      }
      setIntent("start");
      await sender.start(value);
    });
  }

  function stop() {
    if (locked.current === "stop") return;
    generation.current += 1;
    void run("stop", async () => {
      closeScanner();
      await sender.stop();
    });
  }

  return {
    status,
    operation,
    mode,
    setMode,
    invitation,
    setInvitation,
    receiver,
    bitrate,
    setBitrate,
    error,
    setError,
    canPair,
    busy,
    available: sender.available,
    negotiatingVideo: status.state === "connecting" && intent === "start",
    connect,
    start,
    stop,
    acceptScan,
    openScanner,
    closeScanner,
  };
}
