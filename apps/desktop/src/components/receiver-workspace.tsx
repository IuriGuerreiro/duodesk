import { useEffect, useState, type RefObject } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowUpRight,
  CircleHelp,
  Copy,
  Expand,
  Minimize,
  LoaderCircle,
  Monitor,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import type { VideoStats } from "../streaming/receiver";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Separator } from "./ui/separator";
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
  useEffect(() => {
    const update = () =>
      setFullscreen(
        document.fullscreenElement?.classList.contains("receiver-panel") ??
          false,
      );
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const live = state === "streaming";
  const waiting = !!invitation && state === "connecting";
  const label = busy
    ? "Preparing receiver"
    : live
      ? "Receiving video"
      : state === "ready"
        ? "Device connected"
        : waiting
          ? "Waiting for device"
          : state === "failed"
            ? "Connection failed"
            : state === "stopped"
              ? "Session ended"
              : "Ready to connect";
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied to clipboard");
    } catch {
      setCopyStatus("Copy unavailable. Select and copy the text below.");
    }
  }
  return (
    <div className="workspace">
      <main id="receiver">
        {error && (
          <Alert variant="destructive" className="error-notice">
            <CircleHelp />
            <AlertTitle>Unable to continue the session</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="receiver-layout">
          <section className="receiver-panel" aria-labelledby="preview-title">
            <div className="panel-heading">
              <h2 id="preview-title">
                <Radio size={16} /> Live view
              </h2>
              <span role="status">{label}</span>
            </div>
            <div
              className={`video-stage ${live ? "has-video" : ""}`}
              aria-busy={busy}
            >
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                controls
                aria-label="Incoming mobile video"
              />
              {!live && (
                <div className="stage-empty">
                  <div className="device-illustration">
                    <Monitor size={56} strokeWidth={1} />
                    <Smartphone size={29} strokeWidth={1.4} />
                  </div>
                  <h3>
                    {busy
                      ? "Preparing your connection…"
                      : state === "ready"
                        ? "Your device is connected"
                        : waiting
                          ? "Ready when your phone is"
                          : state === "failed"
                            ? "Let's reconnect"
                            : "Your stream belongs here"}
                  </h3>
                  <p>
                    {state === "ready"
                      ? "Press Start on your mobile device to begin streaming."
                      : waiting
                        ? "Use the connection panel to pair your phone."
                        : "Create a connection, then open DuoDesk on your phone. Your video will appear here."}
                  </p>
                  <span className="stage-hint">
                    <ShieldCheck size={13} /> Direct device-to-device video
                  </span>
                </div>
              )}
            </div>
            <div className="video-toolbar">
              <span>
                <span className={`status-dot ${live ? "live-dot" : ""}`} />
                {live
                  ? `${stats?.width ?? 0} × ${stats?.height ?? 0} · ${stats?.fps.toFixed(0) ?? 0} fps`
                  : "Video preview"}
              </span>
              <Button variant="ghost" size="sm" onClick={onFullscreen}>
                {fullscreen ? <Minimize /> : <Expand />}
                {fullscreen ? "Exit fullscreen" : "Fullscreen"}
              </Button>
            </div>
          </section>
          <aside
            className="connection-panel"
            aria-labelledby="connection-title"
          >
            <div className="connection-heading">
              <span className="connection-icon">
                <Wifi size={20} />
              </span>
              <div>
                <h2 id="connection-title">Connect a device</h2>
                <p>Use the same Wi-Fi or local network.</p>
              </div>
            </div>
            {pairing && (
              <div className="code-pairing">
                <p className="field-label">Enter on your phone</p>
                <code>{pairing.address}</code>
                {pairing.code && remaining > 0 && (
                  <strong>{pairing.code}</strong>
                )}
                <p role="status">{pairing.status}</p>
                {waiting && (
                  <span className="code-expiry">
                    {remaining > 0
                      ? `Expires in ${remaining}s`
                      : "Code expired. Create a new connection."}
                  </span>
                )}
              </div>
            )}
            <details
              className={`network-settings ${invitation ? "session-active" : ""}`}
              open={!invitation}
            >
              <summary>Network · {ip}</summary>
              <label className="field-label" htmlFor="desktop-address">
                Desktop address
              </label>
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
                        ? "Choose Wi-Fi or Ethernet"
                        : "No network address found"}
                  </option>
                )}
                {interfaces.map((address) => (
                  <option
                    key={address.address}
                    value={address.address}
                    disabled={!address.selectable}
                  >
                    {address.name} · {address.address}{" "}
                    {address.kind === "lan" ? "" : `(${address.kind})`}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                className="refresh-button"
                onClick={onRefresh}
                disabled={!desktopAvailable || busy || !!invitation}
              >
                <RefreshCw />
                Refresh addresses
              </Button>
              <p className="field-help">
                Choose the network your phone is connected to.
              </p>
              {desktopAvailable && !interfaces.length && (
                <p className="network-help">
                  Connect to Wi-Fi or Ethernet, then refresh the addresses.
                </p>
              )}
            </details>
            <Button
              className="start-button"
              onClick={onStart}
              disabled={!desktopAvailable || !ip || busy}
            >
              {busy ? <LoaderCircle className="spin" /> : <Wifi />}
              {busy
                ? "Creating connection…"
                : invitation
                  ? "Create new connection"
                  : "Create connection"}
              {!busy && <ArrowUpRight />}
            </Button>
            {invitation && (
              <Button
                variant="outline"
                className="stop-button"
                onClick={onStop}
                disabled={busy}
              >
                <Square /> Stop session
              </Button>
            )}
            <Separator className="connection-separator" />
            {waiting ? (
              <div className="pairing-content">
                <details
                  className="qr-details"
                  open={pairing ? undefined : true}
                >
                  <summary>Scan QR code instead</summary>
                  <div className="qr-frame">
                    <QRCodeSVG
                      value={JSON.stringify(invitation)}
                      size={168}
                      level="M"
                      title="Scan to connect to DuoDesk"
                    />
                  </div>
                  <h3>Scan to connect</h3>
                  <p>
                    Open the Stream test tab in DuoDesk on your phone and scan
                    this code.
                  </p>
                </details>
                {!pairing && (
                  <Badge variant="secondary">
                    Expires in {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, "0")}
                  </Badge>
                )}
                <details className="manual-details">
                  <summary>Manual invitation</summary>
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
                  <p role="status">{copyStatus}</p>
                </details>
              </div>
            ) : (
              <div className="setup-guide">
                <p className="eyebrow">{live ? "CONNECTED" : "GET STARTED"}</p>
                {live ? (
                  <p>
                    Your device is sending video. Use the player controls to
                    pause playback or open fullscreen.
                  </p>
                ) : (
                  <ol>
                    <li>
                      <span>1</span>Create a connection on this computer.
                    </li>
                    <li>
                      <span>2</span>Open DuoDesk on your phone.
                    </li>
                    <li>
                      <span>3</span>
                      {pairing
                        ? "Enter the address and code, or scan the QR code."
                        : "Scan the QR code to start pairing."}
                    </li>
                  </ol>
                )}
              </div>
            )}
            <details className="help-details">
              <summary>
                <CircleHelp size={14} />
                Having trouble connecting?
              </summary>
              <p>
                Keep both devices on the same network. Allow DuoDesk through
                your firewall on private networks. Guest Wi-Fi, VPNs, or blocked
                UDP can prevent video. Create a new connection if the invitation
                expires.
              </p>
            </details>
          </aside>
        </div>
      </main>
    </div>
  );
}
