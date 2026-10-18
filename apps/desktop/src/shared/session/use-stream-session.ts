import { useEffect, useRef, useState } from "react";
import type {
  Direction,
  Invitation,
  Signal,
  StreamState,
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
}

export interface StreamSessionOptions {
  direction: Direction;
  /** A signal from the phone for the active session. */
  onSignal: (signal: Signal) => void;
  /** A connection was created. Build the peer for it here. */
  onStarted: (invitation: Invitation, control: SessionControl) => void;
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
        }
        if (payload.state === "stopped" || payload.state === "failed") {
          handlers.current.onEnded();
          pairing.current = undefined;
          setCode("");
          current.current = undefined;
          setInvitation(undefined);
          if (payload.state === "failed")
            setError(
              "Session expired or disconnected. Check Wi-Fi/firewall and create a new connection.",
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

  async function start() {
    setBusy(true);
    setError("");
    try {
      await stop();
      const nextCode = verificationCode();
      const handler = await createPairingServer(nextCode);
      const connection = await invoke<{
        invitation: Invitation;
        address: string;
      }>("stream_start", { ip, direction: handlers.current.direction });
      const next = connection.invitation;
      pairing.current = handler;
      setCode(nextCode);
      setPairingStatus("");
      setAddress(connection.address);
      if (!mounted.current) {
        await invoke("stream_stop");
        return;
      }
      current.current = next;
      handlers.current.onStarted(next, {
        fail: (message) => {
          setError(message);
          void stop();
          setState("failed");
        },
        setState,
      });
      setInvitation(next);
      setRemaining(120);
      setState("connecting");
    } catch (cause) {
      await stop();
      setState("failed");
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    desktopAvailable: isDesktop(),
    interfaces,
    ip,
    onIpChange: setIp,
    onRefresh: () => void refresh(),
    invitation,
    pairing: invitation ? { address, code, status: pairingStatus } : undefined,
    state,
    setState,
    error,
    setError,
    busy,
    remaining,
    onStart: () => void start(),
    onStop: () => void stop(),
  };
}
