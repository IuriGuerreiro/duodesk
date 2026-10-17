import { useEffect, useRef, useState } from "react";
import { invoke, isDesktop, subscribe } from "./host";
import {
  ReceiverWorkspace,
  type NetworkAddress,
} from "./components/receiver-workspace";
import type { Invitation, StreamState } from "@duodesk/protocol";
import { VideoReceiver, type VideoStats } from "./streaming/receiver";
import {
  createPairingServer,
  verificationCode,
} from "@duodesk/protocol/pairing";
import "./App.css";

export default function App() {
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
  const [stats, setStats] = useState<VideoStats>();
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<VideoReceiver | undefined>(undefined);
  const current = useRef<Invitation | undefined>(undefined);
  const mounted = useRef(false);

  function release() {
    peer.current?.stop();
    peer.current = undefined;
    if (video.current) video.current.srcObject = null;
  }
  async function stop() {
    current.current = undefined;
    pairing.current = undefined;
    setCode("");
    setAddress("");
    release();
    setInvitation(undefined);
    setStats(undefined);
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
        peer.current?.receive(payload.signal);
      if (payload.kind === "state" && payload.sessionId === active.sessionId) {
        setState(payload.state);
        if (payload.state === "ready") {
          pairing.current = undefined;
          setCode("");
        }
        if (payload.state === "stopped" || payload.state === "failed") {
          release();
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
      release();
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
      const activePeer = peer.current;
      void activePeer
        ?.stats()
        .then((value) => {
          if (mounted.current && peer.current === activePeer && value)
            setStats(value);
        })
        .catch(() => {});
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
    setStats(undefined);
    try {
      await stop();
      const nextCode = verificationCode();
      const handler = await createPairingServer(nextCode);
      const connection = await invoke<{
        invitation: Invitation;
        address: string;
      }>("stream_start", { ip });
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
      peer.current = new VideoReceiver(
        next.sessionId,
        (signal) => invoke("stream_send", { signal }),
        (stream) => {
          if (video.current) {
            video.current.srcObject = stream;
            void video.current
              .play()
              .catch(() =>
                setError("Press play on the video to start playback."),
              );
          }
        },
        (message) => {
          setError(message);
          void stop();
          setState("failed");
        },
        (connection) => {
          if (connection === "connected") setState("streaming");
        },
      );
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

  return (
    <ReceiverWorkspace
      desktopAvailable={isDesktop()}
      interfaces={interfaces}
      ip={ip}
      onIpChange={setIp}
      onRefresh={() => void refresh()}
      invitation={invitation}
      pairing={
        invitation ? { address, code, status: pairingStatus } : undefined
      }
      state={state}
      error={error}
      stats={stats}
      busy={busy}
      remaining={remaining}
      videoRef={video}
      onStart={() => void start()}
      onStop={() => void stop()}
      onFullscreen={() => {
        const panel = video.current?.closest(".receiver-panel");
        const action = document.fullscreenElement
          ? document.exitFullscreen()
          : panel?.requestFullscreen();
        void action?.catch(() =>
          setError("Fullscreen is unavailable. Try opening the desktop app."),
        );
      }}
    />
  );
}
