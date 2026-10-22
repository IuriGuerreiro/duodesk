import { useState } from "react";
import {
  ArrowUpRight,
  CircleHelp,
  LoaderCircle,
  Monitor,
  QrCode,
  Radio,
  ShieldCheck,
  Smartphone,
  Square,
  Wifi,
} from "lucide-react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import type { ScreenStats } from "./screen-sender";
import type { NetworkAddress } from "@/shared/host";
import { NetworkPicker } from "@/shared/pairing/network-picker";
import { PairingDialog } from "@/shared/pairing/pairing-dialog";
import { Button } from "@/shared/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Separator } from "@/shared/ui/separator";

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
  onShare,
  onStart,
  onStop,
  pairing,
  remaining,
  sharing,
  state,
  stats,
}: ScreenShareWorkspaceProps) {
  const [dismissedSessionId, setDismissedSessionId] = useState<string>();
  const live = state === "streaming";
  const connected = state === "ready" || live;
  const waiting = !!invitation && state === "connecting";
  const modalOpen = Boolean(
    pairing &&
    !connected &&
    invitation &&
    dismissedSessionId !== invitation.sessionId,
  );

  const label = busy
    ? "Preparing connection"
    : live
      ? "Sharing your screen"
      : state === "ready"
        ? "Phone connected"
        : waiting
          ? "Waiting for phone"
          : state === "failed"
            ? "Connection failed"
            : state === "stopped"
              ? "Session ended"
              : "Ready to connect";

  return (
    <div className="workspace">
      <main id="screen-share">
        {error && (
          <Alert variant="destructive" className="error-notice">
            <CircleHelp />
            <AlertTitle>Unable to continue the session</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="receiver-layout">
          <section className="receiver-panel" aria-labelledby="share-title">
            <div className="panel-heading">
              <h2 id="share-title">
                <Radio size={16} /> Screen share
              </h2>
              <span role="status">{label}</span>
            </div>
            <div className="video-stage" aria-busy={busy}>
              <div className="stage-empty">
                <div className="device-illustration">
                  <Monitor size={56} strokeWidth={1} />
                  <Smartphone size={29} strokeWidth={1.4} />
                </div>
                <h3>
                  {live
                    ? "Your phone is showing this screen"
                    : state === "ready"
                      ? "Your phone is connected"
                      : waiting
                        ? "Ready when your phone is"
                        : state === "failed"
                          ? "Let's reconnect"
                          : "Show this screen on your phone"}
                </h3>
                <p>
                  {live
                    ? "Everything on this display, including this window, is visible on the phone."
                    : state === "ready"
                      ? "Starting screen sharing automatically…"
                      : waiting
                        ? "Scan the QR code or enter the address and code on your phone."
                        : "Create a connection, then open DuoDesk on your phone and choose to watch this screen."}
                </p>
                <span className="stage-hint">
                  <ShieldCheck size={13} /> Direct device-to-device video
                </span>
              </div>
            </div>
            <div className="video-toolbar">
              <span>
                <span className={`status-dot ${live ? "live-dot" : ""}`} />
                {live && stats
                  ? `${stats.width} × ${stats.height} · ${stats.fps.toFixed(0)} fps · ${stats.codec.replace("video/", "")} · ${stats.mbps.toFixed(1)} Mbps`
                  : "Not sharing"}
              </span>
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
                <h2 id="connection-title">Connect a phone</h2>
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
                {state === "ready" && !!error && (
                  <Button
                    className="start-button"
                    onClick={onShare}
                    disabled={busy || sharing}
                  >
                    {sharing ? <LoaderCircle className="spin" /> : <Monitor />}
                    {sharing ? "Starting…" : "Retry sharing"}
                  </Button>
                )}
                {pairing && !connected && (
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
              <p className="eyebrow">{live ? "SHARING" : "GET STARTED"}</p>
              {live ? (
                <p>
                  Your phone is showing this screen. Choose Stop session to end
                  it.
                </p>
              ) : (
                <ol>
                  <li>
                    <span>1</span>Choose your network address and create a
                    connection.
                  </li>
                  <li>
                    <span>2</span>On your phone, open DuoDesk and choose to
                    watch this screen.
                  </li>
                  <li>
                    <span>3</span>Scan the QR code, then choose Start sharing
                    here.
                  </li>
                </ol>
              )}
            </div>
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
