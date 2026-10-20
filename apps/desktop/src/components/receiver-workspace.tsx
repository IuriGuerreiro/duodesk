import { useEffect, useRef, useState, type RefObject } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  CircleHelp,
  Copy,
  Expand,
  LoaderCircle,
  Minimize,
  RefreshCw,
  ShieldCheck,
  Square,
  Wifi,
} from "lucide-react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import type { VideoStats } from "../streaming/receiver";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Textarea } from "./ui/textarea";

export interface ReceiverWorkspaceProps {
  desktopAvailable: boolean;
  interfaces: {
    name: string;
    address: string;
    kind: string;
    selectable: boolean;
  }[];
  ip: string;
  onIpChange: (ip: string) => void;
  onRefresh: () => void;
  invitation?: Invitation;
  state: StreamState;
  error: string;
  stats?: VideoStats;
  busy: boolean;
  remaining: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  onStart: () => void;
  onStop: () => void;
  onFullscreen: () => void;
  /** Supplied by the pairing feature. This component never creates codes. */
  pairing?: { address: string; code: string; status: string };
}

type Phase = "setup" | "pair" | "connecting" | "live";

const CHROME_HIDE_MS = 2000;

export function ReceiverWorkspace({
  busy,
  desktopAvailable,
  error,
  interfaces,
  invitation,
  ip,
  onFullscreen,
  onIpChange,
  onRefresh,
  onStart,
  onStop,
  pairing,
  remaining,
  state,
  stats,
  videoRef,
}: ReceiverWorkspaceProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const phase: Phase =
    state === "streaming"
      ? "live"
      : invitation && state === "ready"
        ? "connecting"
        : invitation
          ? "pair"
          : "setup";
  const live = phase === "live";

  useEffect(() => {
    const update = () =>
      setFullscreen(
        document.fullscreenElement?.classList.contains("receiver-panel") ??
          false,
      );
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  // While live, hide the controls until the pointer moves.
  function scheduleHide() {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChromeHidden(true), CHROME_HIDE_MS);
  }
  function wake() {
    setChromeHidden(false);
    if (live) scheduleHide();
  }
  useEffect(() => {
    if (live) scheduleHide();
    return () => clearTimeout(hideTimer.current);
  }, [live]);
  const hidden = live && chromeHidden;

  const label = busy
    ? "Preparing receiver"
    : live
      ? "Live"
      : phase === "connecting"
        ? "Device connected"
        : phase === "pair"
          ? "Waiting for phone"
          : state === "failed"
            ? "Connection failed"
            : state === "stopped"
              ? "Session ended"
              : "Ready to connect";
  const tone = live
    ? "live"
    : state === "failed"
      ? "danger"
      : phase === "setup"
        ? "idle"
        : "busy";

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied to clipboard");
    } catch {
      setCopyStatus("Copy unavailable. Select and copy the text above.");
    }
  }

  const expiry = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <main
      id="receiver"
      className={`receiver-panel phase-${phase} ${hidden ? "chrome-hidden" : ""}`}
      onPointerMove={wake}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          DuoDesk
        </div>
        <span className={`status-pill tone-${tone}`} role="status">
          <span className="dot" />
          {label}
        </span>
        <div className="topbar-actions">
          <label className="network-select">
            <Wifi size={14} />
            <span className="sr-only">Desktop address</span>
            <select
              id="desktop-address"
              value={ip}
              onChange={(e) => onIpChange(e.target.value)}
              disabled={busy || !!invitation || !interfaces.length}
            >
              {!ip && (
                <option value="" disabled>
                  {!desktopAvailable
                    ? "Available in desktop app"
                    : interfaces.length
                      ? "Choose network"
                      : "No network found"}
                </option>
              )}
              {interfaces.map((address) => (
                <option
                  key={address.address}
                  value={address.address}
                  disabled={!address.selectable}
                >
                  {address.name} · {address.address}
                  {address.kind === "lan" ? "" : ` (${address.kind})`}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={!desktopAvailable || busy || !!invitation}
            aria-label="Refresh addresses"
            title="Refresh addresses"
          >
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="sm" onClick={onFullscreen}>
            {fullscreen ? <Minimize /> : <Expand />}
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </Button>
        </div>
      </header>

      <div
        className={`video-stage ${live ? "has-video" : ""}`}
        aria-busy={busy}
      >
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          aria-label="Incoming mobile video"
        />

        {phase === "setup" && (
          <section className="stage-card" aria-labelledby="setup-title">
            <p className="eyebrow">Step 1 of 2</p>
            <h1 id="setup-title">
              {state === "failed" ? "Let's reconnect" : "Pair your phone"}
            </h1>
            <p className="lead">
              Create a connection, then scan the code with DuoDesk on your
              phone. Both devices need the same Wi-Fi.
            </p>
            {error && (
              <Alert variant="destructive" className="error-notice">
                <CircleHelp />
                <AlertTitle>Unable to continue the session</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              size="lg"
              className="primary-action"
              onClick={onStart}
              disabled={!desktopAvailable || !ip || busy}
            >
              {busy ? <LoaderCircle className="spin" /> : <Wifi />}
              {busy ? "Creating connection…" : "Create connection"}
            </Button>
            {desktopAvailable && !interfaces.length && (
              <p className="hint">
                Connect to Wi-Fi or Ethernet, then refresh the addresses.
              </p>
            )}
            <details className="help-details">
              <summary>
                <CircleHelp size={14} />
                Having trouble connecting?
              </summary>
              <p>
                Keep both devices on the same network. Allow DuoDesk through
                your firewall on private networks. Guest Wi-Fi, VPNs, or blocked
                UDP can prevent video.
              </p>
            </details>
          </section>
        )}

        {phase === "pair" && invitation && (
          <section
            className="stage-card pair-card"
            aria-labelledby="pair-title"
          >
            <p className="eyebrow">Step 2 of 2</p>
            <h1 id="pair-title">Scan with your phone</h1>
            <p className="lead">
              Open DuoDesk on your phone and point the camera at this code.
            </p>
            <div className="qr-frame">
              <QRCodeSVG
                value={JSON.stringify(invitation)}
                size={196}
                level="M"
                bgColor="#ffffff"
                fgColor="#0a0a0b"
                title="Scan to connect to DuoDesk"
              />
            </div>
            {pairing && (
              <div className="code-pairing">
                <code>{pairing.address}</code>
                {pairing.code && remaining > 0 && (
                  <strong>{pairing.code}</strong>
                )}
                <p>{pairing.status}</p>
              </div>
            )}
            <p className="expiry">
              {remaining > 0
                ? `Code expires in ${expiry}`
                : "Code expired. Stop and create a new connection."}
            </p>
            <details className="manual-details">
              <summary>Can't scan? Copy the invitation</summary>
              <Textarea
                aria-label="Manual invitation"
                readOnly
                value={JSON.stringify(invitation)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(JSON.stringify(invitation))}
              >
                <Copy />
                Copy invitation
              </Button>
              {copyStatus && <p className="hint">{copyStatus}</p>}
            </details>
            <Button
              variant="ghost"
              className="secondary-action"
              onClick={onStop}
              disabled={busy}
            >
              <Square /> Stop session
            </Button>
          </section>
        )}

        {phase === "connecting" && (
          <section className="stage-card" aria-labelledby="connecting-title">
            <h1 id="connecting-title">Connecting</h1>
            <ol className="steps">
              <li className="done">
                <Check /> Phone found
              </li>
              <li className="done">
                <ShieldCheck /> Secure link ready
              </li>
              <li className="active">
                <LoaderCircle className="spin" /> Waiting for video — press
                Start on your phone
              </li>
            </ol>
            <Button
              variant="ghost"
              className="secondary-action"
              onClick={onStop}
              disabled={busy}
            >
              <Square /> Stop session
            </Button>
          </section>
        )}

        {live && (
          <div className="live-bar">
            <span className="live-stats">
              {stats
                ? `${stats.width} × ${stats.height} · ${stats.fps.toFixed(0)} fps`
                : "Receiving video"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="stop-live"
              onClick={onStop}
            >
              <Square /> Stop session
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
