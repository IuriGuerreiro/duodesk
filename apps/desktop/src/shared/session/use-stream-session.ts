import { useEffect, useRef, useState } from "react";
import type {
  Direction,
  Invitation,
  Signal,
  StreamState,
  RecoveryStatus,
} from "@duodesk/protocol";
import {
  createPairingServer,
  verificationCode,
} from "@duodesk/protocol/pairing";
import {
  invoke,
  isDesktop,
  subscribe,
  type NetworkAddress,
} from "@/shared/host";

export interface SessionControl {
  /** Ends the session and shows `message`. */
  fail: (message: string) => void;
  setState: (state: StreamState) => void;
  recover: (status: RecoveryStatus) => void;
}

export interface StreamSessionOptions {
  direction: Direction;
  rememberedRequestId?: string;
  /** A signal from the phone for the active session. */
  onSignal: (signal: Signal) => void;
  /** A connection was created. Build the peer for it here. */
  onStarted: (invitation: Invitation, control: SessionControl) => void;
  /** The paired phone is ready for media. */
  onReady?: () => void;
  /** The session ended for any reason. Release the peer here. */
  onEnded: () => void;
}

/** Owns the host session, pairing code and countdown that both stream directions share. */
export function useStreamSession(options: StreamSessionOptions) {
  const [interfaces, setInterfaces] = useState<NetworkAddress[]>([]);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pairingStatus, setPairingStatus] = useState("");
  const pairing = useRef<
    Awaited<ReturnType<typeof createPairingServer>> | undefined
  >(undefined);
  const [ip, setIp] = useState("");
  const [invitation, setInvitation] = useState<Invitation>();
  const [state, setState] = useState<StreamState>("idle");
  const [recovery, setRecovery] = useState<RecoveryStatus>();
  const generation = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const current = useRef<Invitation | undefined>(undefined);
  const mounted = useRef(false);
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  async function stop() {
    generation.current++;
    setRecovery(undefined);
    current.current = undefined;
    pairing.current = undefined;
    setCode("");
    setAddress("");
    handlers.current.onEnded();
    setInvitation(undefined);
    setState("stopped");
    await invoke("stream_stop").catch(() => {});
  }

  useEffect(() => {
    mounted.current = true;
    if (!isDesktop()) return;
    void invoke<NetworkAddress[]>("stream_interfaces")
      .then((addresses) => {
        if (mounted.current) {
          setInterfaces(addresses);
          setIp("");
        }
      })
      .catch(() => setError("Could not list local network addresses."));
    const subscription = subscribe((payload) => {
      const active = current.current;
      if (!active || !mounted.current) return;
      if (
        payload.kind === "pairingstatus" &&
        payload.sessionId === active.sessionId
      ) {
        setCode("");
        pairing.current = undefined;
        setPairingStatus(
          payload.status === "used"
            ? "Code verified. Waiting for the phone’s encrypted connection."
            : "Code locked after 8 connection attempts. Create a new connection to try again.",
        );
      }
      if (
        payload.kind === "pairing" &&
        payload.sessionId === active.sessionId
      ) {
        const handler = pairing.current;
        if (handler)
          void handler(payload.requestId, payload.message, active)
            .then((reply) => {
              if (current.current === active)
                return invoke("stream_pair_reply", {
                  reply: { requestId: payload.requestId, ...reply },
                });
            })
            .catch(() => {
              if (current.current === active)
                void invoke("stream_pair_reply", {
                  reply: {
                    requestId: payload.requestId,
                    message: "",
                    complete: false,
                  },
                }).catch(() => {});
            });
      }
      if (
        payload.kind === "signal" &&
        payload.signal.sessionId === active.sessionId
      )
        handlers.current.onSignal(payload.signal);
      if (payload.kind === "state" && payload.sessionId === active.sessionId) {
        setState(payload.state);
        if (payload.state === "ready") {
          pairing.current = undefined;
          setCode("");
          handlers.current.onReady?.();
        }
        if (
          payload.state === "stopped" ||
          payload.state === "failed" ||
          payload.state === "disconnected"
        ) {
          handlers.current.onEnded();
          pairing.current = undefined;
          setCode("");
          current.current = undefined;
          setInvitation(undefined);
          setRecovery(undefined);
          if (payload.state !== "stopped")
            setError(
              payload.message ??
                "Connection lost. Check Wi-Fi and firewall, then pair again.",
            );
        }
      }
    });
    return () => {
      mounted.current = false;
      current.current = undefined;
      pairing.current = undefined;
      handlers.current.onEnded();
      void subscription.then((unlisten) => unlisten());
      void invoke("stream_stop").catch(() => {});
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(
        Math.max(
          0,
          Math.ceil(((current.current?.expiresAt ?? 0) - Date.now()) / 1000),
        ),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function refresh() {
    setBusy(true);
    try {
      const addresses = await invoke<NetworkAddress[]>("stream_interfaces");
      setInterfaces(addresses);
      if (!addresses.some((item) => item.address === ip && item.selectable))
        setIp("");
    } catch {
      setError("Could not refresh local addresses.");
    } finally {
      setBusy(false);
    }
  }

  async function start(requestId?: string) {
    setBusy(true);
    setError("");
    await stop();
    const epoch = generation.current;
    try {
      const nextCode = verificationCode();
      const trust = requestId
        ? undefined
        : await invoke<{ available: boolean }>("trust_status");
      const handler = requestId
        ? undefined
        : await createPairingServer(nextCode, {
            features: trust?.available ? ["trust-v1"] : [],
          });
      if (epoch !== generation.current || !mounted.current) return;
      const connection = await invoke<{
        invitation: Invitation;
        address: string;
      }>(
        requestId ? "trust_start" : "stream_start",
        requestId
          ? { requestId }
          : { ip, direction: handlers.current.direction },
      );
      const next = connection.invitation;
      if (!mounted.current || epoch !== generation.current) {
        await invoke("stream_stop");
        return;
      }
      pairing.current = handler;
      setCode(requestId ? "" : nextCode);
      setPairingStatus("");
      setAddress(connection.address);
      current.current = next;
      handlers.current.onStarted(next, {
        fail: (message) => {
          if (current.current !== next) return;
          setError(message);
          void stop();
          setState("disconnected");
        },
        setState: (state) => {
          if (current.current !== next) return;
          if (state === "streaming") setRecovery(undefined);
          setState(state);
        },
        recover: (status) => {
          if (current.current !== next) return;
          setRecovery(status);
          setState(status.state);
        },
      });
      setInvitation(next);
      setRemaining(120);
      setState("connecting");
      if (requestId) await invoke("trust_ready", { requestId });
    } catch (cause) {
      if (!mounted.current || epoch !== generation.current) return;
      await stop();
      setState("failed");
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  const startRemembered = useRef(start);
  useEffect(() => {
    startRemembered.current = start;
  });
  const lastRememberedRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    const id = options.rememberedRequestId;
    if (id && lastRememberedRequest.current !== id) {
      lastRememberedRequest.current = id;
      void Promise.resolve().then(() => startRemembered.current(id));
    }
  }, [options.rememberedRequestId]);

  return {
    desktopAvailable: isDesktop(),
    interfaces,
    ip,
    onIpChange: setIp,
    onRefresh: () => void refresh(),
    invitation,
    pairing: invitation ? { address, code, status: pairingStatus } : undefined,
    state,
    recovery,
    setState,
    error,
    setError,
    busy,
    remaining,
    onStart: () => void start(),
    onStop: () => void stop(),
  };
}
