import type { RefObject } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Invitation, StreamState } from "@duodesk/protocol";
import type { VideoStats } from "../streaming/receiver";
export type NetworkAddress = {
  name: string;
  address: string;
  kind: string;
  selectable: boolean;
};
export type ReceiverWorkspaceProps = {
  desktopAvailable: boolean;
  interfaces: NetworkAddress[];
  ip: string;
  invitation?: Invitation;
  pairing?: { address: string; code: string; status: string };
  state: StreamState;
  error: string;
  stats?: VideoStats;
  busy: boolean;
  remaining: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  onIpChange: (ip: string) => void;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onFullscreen: () => void;
};
export function ReceiverWorkspace({
  desktopAvailable,
  interfaces,
  ip,
  invitation,
  pairing,
  state,
  error,
  stats,
  busy,
  remaining,
  videoRef,
  onIpChange,
  onRefresh,
  onStart,
  onStop,
  onFullscreen,
}: ReceiverWorkspaceProps) {
  return (
    <main className="container">
      <header>
        <p>DuoDesk / streaming lab</p>
        <h1>Mobile to desktop</h1>
        <p>Stream a silent test clip over your local network.</p>
      </header>
      {!desktopAvailable && (
        <p role="alert">
          Open the native desktop app with pnpm dev:desktop to start the
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
            onChange={(event) => onIpChange(event.target.value)}
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
        <button disabled={busy || !!invitation} onClick={onRefresh}>
          Refresh addresses
        </button>
        <button onClick={onStart} disabled={!desktopAvailable || !ip || busy}>
          {invitation ? "New pairing code" : "Create pairing code"}
        </button>
        <button onClick={onStop} disabled={!invitation || busy}>
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
            <p className="desktop-address">{pairing?.address}</p>
            <p>Six-digit verification code</p>
            <p className="verification-code">{pairing?.code}</p>
            <p role="status">{pairing?.status}</p>
            <p>
              Enter the code, or scan the QR code instead. Pairing expires in{" "}
              {remaining}s. Each code can pair once, with at most 8 connection
              attempts.
            </p>
            <p>
              Allow DuoDesk through your desktop firewall on your private
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
        ref={videoRef}
        autoPlay
        muted
        playsInline
        controls
        aria-label="Incoming mobile video"
      />
      <button onClick={onFullscreen}>Fullscreen</button>
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
