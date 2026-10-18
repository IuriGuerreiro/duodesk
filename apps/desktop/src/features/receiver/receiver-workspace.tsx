import { useEffect, useState, type RefObject } from "react";
import {
  ArrowUpRight,
  CircleHelp,
  Expand,
  LoaderCircle,
  Minimize,
  Monitor,
  QrCode,
  Radio,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import type { VideoStats } from "./video-receiver";
import type { NetworkAddress } from "@/shared/host";
import { NetworkPicker } from "@/shared/pairing/network-picker";
import { PairingDialog } from "@/shared/pairing/pairing-dialog";
import { Button } from "@/shared/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Separator } from "@/shared/ui/separator";

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
  const [fullscreen, setFullscreen] = useState(false);
  const [dismissedSessionId, setDismissedSessionId] = useState<string>();

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
  const modalOpen = Boolean(
    pairing &&
    !live &&
    invitation &&
    dismissedSessionId !== invitation.sessionId,
  );

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
                        ? "Scan the QR code or enter the address and code on your phone."
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
            {!invitation ? (
              <>
                <NetworkPicker
                  desktopAvailable={desktopAvailable}
                  busy={busy}
                  interfaces={interfaces}
                  ip={ip}
                  onIpChange={onIpChange}
                  onRefresh={onRefresh}
                />
                <Button
                  className="start-button"
                  onClick={() => {
                    setDismissedSessionId(undefined);
                    onStart();
                  }}
                  disabled={!desktopAvailable || !ip || busy}
                >
                  {busy ? <LoaderCircle className="spin" /> : <Wifi />}
                  {busy ? "Creating connection…" : "Create connection"}
                  {!busy && <ArrowUpRight />}
                </Button>
              </>
            ) : (
              <div className="active-session-controls">
                <div className="session-network-badge">
                  <span>Network</span>
                  <code>{pairing?.address ?? ip}</code>
                </div>
                {pairing && !live && (
                  <Button
                    className="start-button"
                    onClick={() => setDismissedSessionId(undefined)}
                    disabled={busy}
                  >
                    <QrCode /> Show pairing QR & code
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="stop-button"
                  onClick={() => {
                    setDismissedSessionId(undefined);
                    onStop();
                  }}
                  disabled={busy}
                >
                  <Square /> Stop session
                </Button>
              </div>
            )}
            <Separator className="connection-separator" />
            <div className="setup-guide">
              <p className="eyebrow">{live ? "CONNECTED" : "GET STARTED"}</p>
              {live ? (
                <p>
                  Your device is sending video. Use the player controls to pause
                  playback or open fullscreen.
                </p>
              ) : (
                <ol>
                  <li>
                    <span>1</span>Choose your network address and create a
                    connection.
                  </li>
                  <li>
                    <span>2</span>Open DuoDesk on your phone.
                  </li>
                  <li>
                    <span>3</span>Scan the QR code or enter the IP and code in
                    the pairing popup.
                  </li>
                </ol>
              )}
            </div>
            <details className="help-details">
              <summary>
                <CircleHelp size={14} />
                Having trouble connecting?
              </summary>
              <p>
                Keep both devices on the same network. Allow DuoDesk through
                your firewall on private networks. Guest Wi-Fi, VPNs, or blocked
                UDP can prevent video. Create a new connection if the code
                expires.
              </p>
            </details>
          </aside>
        </div>
        {modalOpen && pairing && invitation && (
          <PairingDialog
            pairing={pairing}
            waiting={waiting}
            remaining={remaining}
            busy={busy}
            onClose={() => setDismissedSessionId(invitation.sessionId)}
            onNewCode={() => {
              setDismissedSessionId(undefined);
              onStart();
            }}
            onStop={() => {
              setDismissedSessionId(undefined);
              onStop();
            }}
          />
        )}
      </main>
    </div>
  );
}
