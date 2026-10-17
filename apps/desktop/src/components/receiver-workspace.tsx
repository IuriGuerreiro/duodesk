import { useState, type RefObject } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowUpRight,
  CircleHelp,
  Copy,
  Expand,
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

export type NetworkAddress = {
  name: string;
  address: string;
  kind: string;
  selectable: boolean;
};

export interface ReceiverWorkspaceProps {
  desktopAvailable: boolean;
  interfaces: NetworkAddress[];
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
  const hasSelectableAddress = interfaces.some((address) => address.selectable);
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
      <header className="app-header">
        <a className="brand" href="#receiver" aria-label="DuoDesk receiver">
          <span className="brand-mark">
            <Monitor size={21} />
          </span>
          DuoDesk
          <span className="brand-divider" />{" "}
          <span className="brand-context">Desktop receiver</span>
        </a>
        <Badge variant="outline" className="local-badge">
          <ShieldCheck size={13} /> Local network only
        </Badge>
      </header>
      <main id="receiver">
        <div className="page-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>Mobile stream</h1>
            <p>Connect your phone over your local network.</p>
          </div>
          <Badge
            variant="outline"
            className={`state-badge ${live ? "is-live" : ""}`}
            role="status"
          >
            <span className="status-dot" />
            {label}
          </Badge>
        </div>
        {!desktopAvailable && (
          <Alert className="preview-notice">
            <Monitor />
            <AlertTitle>Desktop app required</AlertTitle>
            <AlertDescription>
              This browser preview cannot receive video. Open DuoDesk on your
              computer to connect a device.
            </AlertDescription>
          </Alert>
        )}
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
              <span>{live ? "LIVE" : "NO SIGNAL"}</span>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={onFullscreen}
                disabled={!live}
              >
                <Expand /> Fullscreen
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
                <code aria-label="Desktop address and port">
                  {pairing.address}
                </code>
                {pairing.code && remaining > 0 && (
                  <strong aria-label="Six-digit verification code">
                    {pairing.code}
                  </strong>
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
                disabled={busy || !!invitation || !hasSelectableAddress}
              >
                {!ip && (
                  <option value="" disabled>
                    {!desktopAvailable
                      ? "Available in desktop app"
                      : hasSelectableAddress
                        ? "Choose Wi-Fi or Ethernet"
                        : "No network address found"}
                  </option>
                )}
                {interfaces.map((address) => (
                  <option
                    key={`${address.name}:${address.address}`}
                    value={address.address}
                    disabled={!address.selectable}
                  >
                    {address.name} · {address.address}{" "}
                    {address.kind === "lan"
                      ? ""
                      : address.kind === "virtual"
                        ? "(Likely virtual / VPN)"
                        : `(${address.kind})`}
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
              {desktopAvailable && !hasSelectableAddress && (
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
        <details className="diagnostics">
          <summary>
            <span>
              <Radio size={15} />
              Connection diagnostics
            </span>
            <span>{stats ? stats.codec : "Waiting for stream"}</span>
          </summary>
          <dl className="diagnostic-grid">
            {[
              ["Status", label],
              [
                "Resolution",
                stats ? `${stats.width} × ${stats.height}` : "No video yet",
              ],
              [
                "Frame rate",
                stats ? `${stats.fps.toFixed(0)} fps` : "Unavailable",
              ],
              [
                "Bitrate",
                stats ? `${stats.mbps.toFixed(2)} Mbps` : "Unavailable",
              ],
              ["Packets lost", stats?.packetsLost],
              ["Frames dropped", stats?.framesDropped],
              [
                "Average decode",
                stats ? `${stats.decodeMs.toFixed(1)} ms` : "Unavailable",
              ],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value ?? "Unavailable"}</dd>
              </div>
            ))}
          </dl>
        </details>
        <footer>
          <span>DuoDesk</span>
          <span>Video stays between your devices.</span>
        </footer>
      </main>
    </div>
  );
}
