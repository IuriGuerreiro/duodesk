import type { TrustStatus } from "@/shared/host";
import { Button } from "@/shared/ui/button";
import { ShieldCheck } from "lucide-react";

export interface TrustedDevicesProps {
  status: TrustStatus;
  busy: boolean;
  canEnable: boolean;
  notice: string;
  error: string;
  onAllow: (allow: boolean) => void;
  onApprove: (requestId: string, approve: boolean) => void;
  onRevoke: (phoneId: string) => void;
}

export function TrustedDevices({
  status,
  busy,
  canEnable,
  notice,
  error,
  onAllow,
  onApprove,
  onRevoke,
}: TrustedDevicesProps) {
  return (
    <section className="trusted-devices" aria-labelledby="trusted-title">
      <h2 id="trusted-title">
        <ShieldCheck size={16} /> Trusted devices
      </h2>
      {notice && (
        <p className="trust-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="trust-error" role="alert">
          {error}
        </p>
      )}
      {!status.available ? (
        <p>
          {status.reason ??
            "Remembering devices requires secure storage in the Electron app."}
        </p>
      ) : (
        <>
          <label className="trust-toggle">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy || (!status.enabled && !canEnable)}
              onChange={(event) => onAllow(event.target.checked)}
            />
            <span>Allow reconnects</span>
          </label>
          <p>
            {status.enabled
              ? "Trusted phones can connect without a code. Each connection appears here."
              : "Off. Turn on to accept trusted phones without a code."}
          </p>
          {!status.enabled && !canEnable && (
            <p>Choose a network address above to enable reconnects.</p>
          )}
          {status.address && (
            <p>
              Saved desktop address{" "}
              <code className="trust-address">{status.address}</code>
            </p>
          )}
          {status.pending.map((request) => (
            <div className="trust-request" key={request.requestId}>
              <strong>Remember {request.name}?</strong>
              <p>
                This phone just paired. Approve only if you chose Remember on
                it.
              </p>
              <code className="trust-key">
                Phone key {request.phoneId.slice(0, 16)}
              </code>
              <div className="trust-actions">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onApprove(request.requestId, true)}
                >
                  Remember phone
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onApprove(request.requestId, false)}
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
          {status.devices.length === 0 ? (
            <p>
              No trusted phones. Pair with a code and choose Remember on your
              Android phone.
            </p>
          ) : (
            <ul className="trust-list">
              {status.devices.map((device) => (
                <li key={device.phoneId}>
                  <div>
                    <strong>{device.name}</strong>
                    <code className="trust-key">
                      {device.phoneId.slice(0, 16)}
                    </code>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRevoke(device.phoneId)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p>
            Remembering a phone does not allow remote control. Screen sharing
            still needs phone consent.
          </p>
        </>
      )}
    </section>
  );
}
