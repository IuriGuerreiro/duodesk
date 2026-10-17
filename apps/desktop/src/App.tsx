import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QRCodeSVG } from "qrcode.react";
import type { Invitation, Signal, StreamState } from "@duodesk/protocol";
import { VideoReceiver, type VideoStats } from "./streaming/receiver";
import {
  createPairingServer,
  verificationCode,
} from "@duodesk/protocol/pairing";
import "./App.css";
type NetworkAddress = {
  name: string;
  address: string;
  kind: string;
  selectable: boolean;
};

type StreamEvent =
  | { kind: "pairingstatus"; sessionId: string; status: "used" | "locked" }
  | { kind: "pairing"; sessionId: string; requestId: string; message: string }
  | { kind: "signal"; signal: Signal }
  | { kind: "state"; sessionId: string; state: StreamState };

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
    if (!isTauri()) return;
    void invoke<NetworkAddress[]>("stream_interfaces")
      .then((addresses) => {
        if (mounted.current) {
          setInterfaces(addresses);
          setIp("");
        }
      })
      .catch(() => setError("Could not list local network addresses."));
    const subscription = listen<StreamEvent>("stream-event", ({ payload }) => {
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
            : "Code locked after 8 connection attempts. Create a new pairing code, or use QR.",
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
              "Session expired or disconnected. Check Wi-Fi/firewall and create a new invitation.",
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
    <main className="container">
      <header>
        <p>DuoDesk / streaming lab</p>
        <h1>Mobile to Windows</h1>
        <p>Stream a silent test clip over your local network.</p>
      </header>
      {!isTauri() && (
        <p role="alert">
          Open the native desktop app with pnpm dev:desktop:tauri to start the
          receiver.
        </p>
      )}
      {!invitation && (
        <section aria-label="Desktop network">
          <h2>1. Choose the network your phone is on</h2>
          <p>
            Use the Wi-Fi or Ethernet adapter connected to the same router as
            your phone. Adapter names are hints, not proof. VPNs, virtual
            adapters and guest Wi-Fi may block a connection.
          </p>
          <p className="desktop-address" aria-live="polite">
            {ip || "No address selected"}
          </p>
          <p>
            Your phone connects to this computer’s address. Do not enter the
            phone’s own IP address.
          </p>
        </section>
      )}
      <section className="connection">
        <label>
          Choose this computer’s Wi-Fi or Ethernet address{" "}
          <select
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            disabled={busy || !!invitation}
          >
            <option value="">Select a network address</option>
            {interfaces.map((item) => (
              <option
                key={`${item.name}:${item.address}`}
                value={item.address}
                disabled={!item.selectable}
              >
                {item.address} · {item.name} ·{" "}
                {item.kind === "lan"
                  ? "Local network"
                  : item.kind === "virtual"
                    ? "Likely virtual / VPN"
                    : item.kind}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={busy || !!invitation}
          onClick={() => {
            setBusy(true);
            void invoke<NetworkAddress[]>("stream_interfaces")
              .then((addresses) => {
                setInterfaces(addresses);
                if (
                  !addresses.some(
                    (item) => item.address === ip && item.selectable,
                  )
                )
                  setIp("");
              })
              .catch(() => setError("Could not refresh local addresses."))
              .finally(() => setBusy(false));
          }}
        >
          Refresh addresses
        </button>
        <button
          onClick={() => void start()}
          disabled={!isTauri() || !ip || busy}
        >
          {invitation ? "New pairing code" : "Create pairing code"}
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
            <h2>2. Connect your phone</h2>
            <p>
              In the Stream test tab, enter this desktop address including the
              port:
            </p>
            <p className="desktop-address">{address}</p>
            <p>Six-digit verification code</p>
            <p className="verification-code">{code}</p>
            <p role="status">{pairingStatus}</p>
            <p>
              Enter the code, or scan the QR code instead. Pairing expires in{" "}
              {remaining}s. Each code can pair once, with at most 8 connection
              attempts.
            </p>
            <p>
              Allow DuoDesk through the Windows firewall on your private
              network.
            </p>
            <details>
              <summary>Diagnostics / legacy invitation</summary>
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
