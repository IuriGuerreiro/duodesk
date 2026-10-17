import { useEffect, useRef, useState } from "react";
import { invoke, isDesktop, subscribe } from "./host";
import { QRCodeSVG } from "qrcode.react";
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
    <main className="container">
      <header>
        <p>DuoDesk / streaming lab</p>
        <h1>Mobile to desktop</h1>
        <p>Stream a silent test clip over your local network.</p>
      </header>
      {!isDesktop() && (
        <p role="alert">
          Open the native desktop app with pnpm dev:desktop to start the
          receiver.
        </p>
      )}
      <section className="connection">
        <label>
          Desktop LAN address{" "}
          <select
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            disabled={busy || !!invitation}
          >
            {interfaces.map((address) => (
              <option key={address}>{address}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void start()}
          disabled={!isDesktop() || !ip || busy}
        >
          {invitation ? "New invitation" : "Create invitation"}
        </button>
        <button onClick={() => void stop()} disabled={!invitation || busy}>
          Stop
        </button>
        <p role="status">{state}</p>
      </section>
      {invitation && state === "connecting" && (
        <section className="pairing">
          <div className="qr">
            <QRCodeSVG
              value={JSON.stringify(invitation)}
              size={224}
              level="M"
            />
          </div>
          <div>
            <h2>Connect your mobile device</h2>
            <p>
              Open the Stream test tab in DuoDesk and scan this code. Invitation
              expires in {remaining}s.
            </p>
            <p>Allow DuoDesk through your firewall on your private network.</p>
            <details>
              <summary>Manual invitation</summary>
              <textarea
                aria-label="Manual invitation"
                readOnly
                value={JSON.stringify(invitation)}
              />
            </details>
          </div>
        </section>
      )}
      {state === "ready" && (
        <p>Mobile device connected. Press Start on the mobile device.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        controls
        aria-label="Incoming mobile video"
      />
      <button
        onClick={() =>
          void video.current
            ?.requestFullscreen()
            .catch(() => setError("Fullscreen is unavailable."))
        }
      >
        Fullscreen
      </button>
      {stats && (
        <p className="stats">
          {stats.codec} · {stats.width} × {stats.height} ·{" "}
          {stats.fps.toFixed(0)} fps · {stats.mbps.toFixed(2)} Mbps
          <br />
          {stats.packetsLost} packets lost · {stats.framesDropped} frames
          dropped · {stats.decodeMs.toFixed(1)} ms average decode
        </p>
      )}
    </main>
  );
}
