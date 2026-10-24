import { QRCodeSVG } from "qrcode.react";
import {
  CircleHelp,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  ShieldCheck,
  Square,
  Wifi,
} from "lucide-react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import { createPairingQrPayload } from "@duodesk/protocol/pairing";
import type { ScreenStats } from "./screen-sender";
import type { NetworkAddress } from "@/shared/host";
import { Button } from "@/shared/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";

export interface ScreenShareWorkspaceProps {
  desktopAvailable: boolean;
  interfaces: NetworkAddress[];
  ip: string;
  onIpChange: (ip: string) => void;
  onRefresh: () => void;
  invitation?: Invitation;
  /** Supplied by the shared session. This component never creates codes. */
  pairing?: { address: string; code: string; status: string };
  state: StreamState;
  error: string;
  stats?: ScreenStats;
  sharing: boolean;
  busy: boolean;
  remaining: number;
  onReceive: () => void;
  onStart: () => void;
  onStop: () => void;
  onShare: () => void;
}

export function ScreenShareWorkspace({
  busy,
  desktopAvailable,
  error,
  interfaces,
  invitation,
  ip,
  onIpChange,
  onRefresh,
  onReceive,
  onShare,
  onStart,
  onStop,
  pairing,
  remaining,
  sharing,
  state,
  stats,
}: ScreenShareWorkspaceProps) {
  const live = state === "streaming";
  const phase = live
    ? "live"
    : state === "ready"
      ? "connecting"
      : invitation
        ? "pair"
        : "setup";
  const label = live
    ? "Sharing your screen"
    : sharing
      ? "Starting screen sharing"
      : invitation
        ? "Waiting for phone"
        : state === "stopped"
          ? "Session ended"
          : "Ready to share";
  const tone = live
    ? "live"
    : state === "failed"
      ? "danger"
      : invitation
        ? "busy"
        : "idle";
  const expiry = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <main id="screen-share" className={`receiver-panel phase-${phase}`}>
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
        </div>
      </header>

      <div className="video-stage">
        {error && (
          <Alert variant="destructive" className="error-notice">
            <CircleHelp />
            <AlertTitle>Screen sharing could not start</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {phase === "setup" && (
          <section className="stage-card" aria-labelledby="share-title">
            <p className="eyebrow">Step 1 of 2</p>
            <h1 id="share-title">Show this screen on your phone</h1>
            <p className="lead">
              Create a connection and scan its code with DuoDesk on your phone.
              Sharing starts automatically when it connects.
            </p>
            <Button
              size="lg"
              className="primary-action"
              onClick={onStart}
              disabled={!desktopAvailable || !ip || busy}
            >
              {busy ? <LoaderCircle className="spin" /> : <Wifi />}
              {busy ? "Creating connection…" : "Create connection"}
            </Button>
            <Button
              variant="ghost"
              className="secondary-action"
              onClick={onReceive}
              disabled={busy}
            >
              <Smartphone /> Receive from phone
            </Button>
          </section>
        )}
        {phase === "pair" && pairing && (
          <section
            className="stage-card pair-card"
            aria-labelledby="pair-title"
          >
            <p className="eyebrow">Step 2 of 2</p>
            <h1 id="pair-title">Scan with your phone</h1>
            <p className="lead">
              Open DuoDesk on your phone and scan this code to watch your PC
              screen.
            </p>
            {pairing.code && remaining > 0 && (
              <div className="qr-frame">
                <QRCodeSVG
                  value={createPairingQrPayload(pairing.address, pairing.code)}
                  size={196}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#0a0a0b"
                  title="DuoDesk address and six-digit pairing code"
                />
              </div>
            )}
            <div className="code-pairing">
              <code aria-label="Desktop address and port">
                {pairing.address}
              </code>
              {pairing.code && remaining > 0 && (
                <strong aria-label="Six-digit verification code">
                  {pairing.code}
                </strong>
              )}
              {pairing.status && <p role="status">{pairing.status}</p>}
            </div>
            <p className="expiry">
              {remaining > 0
                ? `Code expires in ${expiry}`
                : "Code expired. Stop and create a new connection."}
            </p>
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
          <section className="stage-card" aria-labelledby="starting-title">
            <h1 id="starting-title">
              {error ? "Try sharing again" : "Starting screen sharing"}
            </h1>
            <p className="lead">
              {error
                ? "Your phone is still connected."
                : "Your phone is connected. Its picture will appear automatically."}
            </p>
            {error && (
              <Button
                className="primary-action"
                onClick={onShare}
                disabled={sharing || busy}
              >
                {sharing ? "Starting…" : "Retry sharing"}
              </Button>
            )}
            <Button
              variant="ghost"
              className="secondary-action"
              onClick={onStop}
            >
              <Square /> Stop session
            </Button>
          </section>
        )}
        {live && (
          <>
            <section className="stage-card" aria-labelledby="sharing-title">
              <ShieldCheck size={32} />
              <h1 id="sharing-title">Your phone is showing this screen</h1>
              <p className="lead">
                Everything on this display is visible on your phone. Audio is
                not shared.
              </p>
              <Button
                variant="destructive"
                className="primary-action"
                onClick={onStop}
              >
                <Square /> Stop session
              </Button>
            </section>
            <div className="live-bar">
              <span className="live-stats">
                {stats
                  ? `${stats.width} × ${stats.height} · ${stats.fps.toFixed(0)} fps · ${stats.codec.replace("video/", "")} · ${stats.mbps.toFixed(1)} Mbps`
                  : "Sharing your screen"}
              </span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
