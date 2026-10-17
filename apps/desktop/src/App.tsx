import { useEffect, useRef, useState } from "react";
import { invoke, isDesktop, subscribe } from "./host";
import { ReceiverWorkspace } from "./components/receiver-workspace";
import type { Invitation, StreamState } from "@duodesk/protocol";
import { VideoReceiver, type VideoStats } from "./streaming/receiver";
import "./App.css";

export default function App() {
  const [interfaces, setInterfaces] = useState<string[]>([]);
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
    release();
    setInvitation(undefined);
    setStats(undefined);
    setState("stopped");
    await invoke("stream_stop").catch(() => {});
  }

  useEffect(() => {
    mounted.current = true;
    if (!isDesktop()) return;
    void invoke<string[]>("stream_interfaces")
      .then((addresses) => {
        if (mounted.current) {
          setInterfaces(addresses);
          setIp(addresses[0] ?? "");
        }
      })
      .catch(() => setError("Could not list local network addresses."));
    const subscription = subscribe((payload) => {
      const active = current.current;
      if (!active || !mounted.current) return;
      if (
        payload.kind === "signal" &&
        payload.signal.sessionId === active.sessionId
      )
        peer.current?.receive(payload.signal);
      if (payload.kind === "state" && payload.sessionId === active.sessionId) {
        setState(payload.state);
        if (payload.state === "stopped" || payload.state === "failed") {
          release();
          current.current = undefined;
          setInvitation(undefined);
          if (payload.state === "failed")
            setError(
              "Session expired or disconnected. Check Wi-Fi/firewall and create a new invitation.",
            );
        }
      }
    });
    return () => {
      mounted.current = false;
      current.current = undefined;
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

  async function start() {
    setBusy(true);
    setError("");
    setStats(undefined);
    try {
      await stop();
      const next = await invoke<Invitation>("stream_start", { ip });
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
      interfaces={interfaces.map((address) => ({
        name: "Local network",
        address,
        kind: "lan",
        selectable: true,
      }))}
      ip={ip}
      onIpChange={setIp}
      onRefresh={() => {
        void invoke<string[]>("stream_interfaces")
          .then((addresses) => {
            setInterfaces(addresses);
            setIp(addresses.includes(ip) ? ip : (addresses[0] ?? ""));
          })
          .catch(() =>
            setError(
              "Could not refresh network addresses. Check your network connection.",
            ),
          );
      }}
      invitation={invitation}
      state={state}
      error={error}
      stats={stats}
      busy={busy}
      remaining={remaining}
      videoRef={video}
      onStart={() => void start()}
      onStop={() => void stop()}
      onFullscreen={() =>
        void video.current
          ?.requestFullscreen()
          .catch(() => setError("Fullscreen is unavailable."))
      }
    />
  );
}
