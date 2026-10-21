import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  Keyboard,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { parsePairingQrPayload } from "@duodesk/protocol/pairing";
import {
  connectToDesktop,
  createScanGate,
  pairWithCode,
  type PairingMode,
} from "@/features/pairing";
import * as sender from "../../../modules/test-video";
import type { SavedDesktop, SenderStatus } from "../../../modules/test-video";
import {
  createReconnectFlow,
  type ReconnectState,
} from "@/features/trusted-desktops";

type Operation =
  "reconnect" | "trust" | "connect" | "start" | "screen" | "stop" | null;

async function localNetworkPermission() {
  if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
    );
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      throw new Error(
        "Local network access is blocked. Allow it for DuoDesk in your phone’s app settings, then connect again.",
      );
    }
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new Error("Allow local network access to connect to your PC.");
    }
  }
}

/** Android requires RECORD_AUDIO for any audio capture, including other apps' playback. Denial means video only. */
async function playbackAudioPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: "Share phone audio",
      message:
        "Android needs this permission to capture sound from other apps. DuoDesk does not record your microphone.",
      buttonPositive: "Continue",
      buttonNegative: "Not now",
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function parseBitrate(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 2 || value > 30) {
    throw new Error("Choose a whole number from 2 to 30 Mbps.");
  }
  return value;
}

export function useSenderSession() {
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [operation, setOperation] = useState<Operation>(null);
  const [mode, setMode] = useState<PairingMode>("closed");
  const [address, setAddressValue] = useState("");
  const [code, setCodeValue] = useState("");
  const [notice, setNotice] = useState("");
  const [receiver, setReceiver] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState("12");
  const [shareAudio, setShareAudio] = useState(true);
  const [audioNotice, setAudioNotice] = useState("");
  const [error, setError] = useState("");
  const [remember, setRemember] = useState(false);
  const [savedDesktops, setSavedDesktops] = useState<SavedDesktop[]>([]);
  const [trustError, setTrustError] = useState("");
  const [trustNotice, setTrustNotice] = useState("");
  const [reconnectState, setReconnectState] = useState<ReconnectState>({
    kind: "idle",
  });
  const [intent, setIntent] = useState<"connect" | "start" | "screen">(
    "connect",
  );
  const locked = useRef<Operation>(null);
  const requestId = useRef(0);
  const active = useRef(true);
  const generation = useRef(0);
  const [gate] = useState(() => createScanGate(parsePairingQrPayload));
  // Android can report a system permission dialog as the app going to the
  // background; that must not cancel the attempt waiting on the answer.
  const prompts = useRef(0);
  const statusRef = useRef<SenderStatus>(status);
  const eventSeq = useRef(0);
  const [reconnectFlow] = useState(() =>
    createReconnectFlow({
      request: sender.reconnectTrusted,
      connect: sender.connect,
      close: sender.cancelTrusted,
      onState: setReconnectState,
    }),
  );

  const refreshSaved = useCallback(async () => {
    if (!sender.supportsTrustedDevices) return;
    try {
      const desktops = await sender.listTrustedDesktops();
      if (active.current) {
        setSavedDesktops(desktops);
        setTrustError("");
      }
    } catch (cause) {
      if (active.current)
        setTrustError(
          cause instanceof Error
            ? cause.message
            : "Saved desktops could not be loaded.",
        );
    }
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const closeScanner = useCallback(() => {
    gate.close();
    setMode("closed");
  }, [gate]);

  const guardPrompt = useCallback(async <T>(request: () => Promise<T>) => {
    prompts.current += 1;
    try {
      return await request();
    } finally {
      prompts.current -= 1;
    }
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
    void reconnectFlow.cancel();
    const current = statusRef.current;
    if (current.mode !== "screen" || current.state !== "streaming") {
      void sender.background();
    }
  }, [closeScanner, reconnectFlow]);

  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(refreshSaved);
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
        void refreshSaved();
      } else if (next === "background" && prompts.current === 0) {
        generation.current += 1;
        closeScanner();
        void sender.pairClose();
        void reconnectFlow.cancel();
        void sender.background();
      }
    });
    return () => {
      active.current = false;
      subscription.remove();
      appState.remove();
      leaveScreen();
    };
  }, [closeScanner, leaveScreen, reconnectFlow, refreshSaved, syncStatus]);

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

  const run = useCallback(
    async (
      kind: Exclude<Operation, null>,
      action: (epoch: number) => Promise<void>,
    ) => {
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
    },
    [],
  );

  function setAddress(value: string) {
    setAddressValue(value);
    setNotice("");
  }

  function setCode(value: string) {
    setCodeValue(value.replace(/[^0-9]/g, "").slice(0, 6));
    setNotice("");
  }

  function pair(target: string, pairingCode: string) {
    Keyboard.dismiss();
    void run("connect", async (epoch) => {
      setTrustNotice("");
      await connectToDesktop(
        {
          requestLocalNetwork: () => guardPrompt(localNetworkPermission),
          pair: pairWithCode,
          connect: sender.connect,
          connectRemembered: async (invitation) => {
            setTrustNotice(
              "Waiting for approval on your PC. Keep DuoDesk open on both devices.",
            );
            try {
              await sender.connectAndRemember(invitation, "Android phone");
              if (active.current && generation.current === epoch) {
                setTrustNotice(
                  "Desktop saved. Turn on Allow reconnects in DuoDesk on your PC when you want to reconnect.",
                );
                await refreshSaved();
              }
            } catch (cause) {
              if (active.current && generation.current === epoch)
                setTrustNotice("");
              throw cause;
            }
          },
        },
        {
          address: target,
          code: pairingCode,
          remember: remember && sender.supportsTrustedDevices,
          cancelled: () => !active.current || generation.current !== epoch,
          onPaired: () => {
            closeScanner();
            setIntent("connect");
            setReceiver(target);
            setCodeValue("");
          },
        },
      );
    });
  }

  function connect() {
    if (!canPair || !sender.available || !canSubmit) return;
    pair(address.trim(), code);
  }

  // A valid QR is a complete request: connect without a second tap. Fields stay
  // filled and visible so a failed attempt can be retried or corrected.
  function acceptScan(text: string) {
    if (locked.current || !canPair || !sender.available) return;
    const scan = gate.accept(text);
    if (scan.kind === "invalid") {
      setError(scan.message);
    } else if (scan.kind === "pairing") {
      setAddressValue(scan.address);
      setCodeValue(scan.code);
      setNotice("");
      setMode("manual");
      pair(scan.address, scan.code);
    }
  }

  function openScanner() {
    gate.open();
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
      let audio = shareAudio && sender.supportsPlaybackAudio;
      setAudioNotice("");
      if (audio && !(await playbackAudioPermission())) {
        audio = false;
        setAudioNotice(
          "Audio permission was denied, so only video is shared. You can allow it in Android settings.",
        );
      }
      setIntent("screen");
      await sender.startScreen(value, audio);
    });
  }

  const stop = useCallback(() => {
    if (locked.current === "stop") return;
    generation.current += 1;
    void run("stop", async () => {
      closeScanner();
      void sender.pairClose();
      await reconnectFlow.cancel();
      setTrustNotice("");
      await sender.stop();
    });
  }, [closeScanner, reconnectFlow, run]);

  function reconnectDesktop(desktop: SavedDesktop, nextAddress: string) {
    if (!canPair || !sender.supportsTrustedDevices || busy) return;
    Keyboard.dismiss();
    void run("reconnect", async (epoch) => {
      closeScanner();
      setTrustNotice("");
      await guardPrompt(localNetworkPermission);
      if (!active.current || generation.current !== epoch) return;
      await sender.updateTrustedAddress(
        desktop.fingerprint,
        nextAddress.trim(),
      );
      if (!active.current || generation.current !== epoch) return;
      await refreshSaved();
      setReceiver(nextAddress.trim());
      setIntent("connect");
      await reconnectFlow.run(desktop.fingerprint);
    });
  }

  function forgetDesktop(fingerprint: string) {
    if (busy) return;
    void run("trust", async () => {
      await reconnectFlow.cancel();
      await sender.forgetTrustedDesktop(fingerprint);
      setTrustNotice(
        "Desktop forgotten on this phone. Remove this phone from the PC's approved devices to revoke its desktop entry too.",
      );
      await refreshSaved();
    });
  }

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (locked.current === "connect" || locked.current === "reconnect") {
            stop();
            return true;
          }
          if (mode === "scan") {
            closeScanner();
            return true;
          }
          return false;
        },
      );
      return () => subscription.remove();
    }, [mode, closeScanner, stop]),
  );

  return {
    status,
    remember,
    setRemember,
    savedDesktops,
    trustError,
    trustNotice,
    supportsTrustedDevices: sender.supportsTrustedDevices,
    reconnectState,
    reconnectDesktop,
    forgetDesktop,
    retrySaved: refreshSaved,
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
    shareAudio,
    setShareAudio,
    audioNotice,
    supportsPlaybackAudio: sender.supportsPlaybackAudio,
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
    guardPrompt,
    openScanner,
    closeScanner,
  };
}
