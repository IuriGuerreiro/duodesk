import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { RefreshCw, Square, X } from "lucide-react";
import { createPairingQrPayload } from "@duodesk/protocol/pairing";
import { Button } from "@/shared/ui/button";

export interface PairingDialogProps {
  pairing: { address: string; code: string; status: string };
  waiting: boolean;
  remaining: number;
  busy: boolean;
  onClose: () => void;
  onNewCode: () => void;
  onStop: () => void;
}

export function PairingDialog({
  pairing,
  waiting,
  remaining,
  busy,
  onClose,
  onNewCode,
  onStop,
}: PairingDialogProps) {
  const hasActivePairingCode = Boolean(pairing.code && remaining > 0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="pairing-modal-backdrop" onClick={onClose}>
      <div
        className="pairing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pairing-modal-header">
          <div>
            <h2 id="pairing-modal-title">Pair your phone</h2>
            <p>
              {hasActivePairingCode
                ? "Scan the QR code or enter the details below on your phone"
                : "Enter on your phone"}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="pairing-modal-close"
            aria-label="Close pairing dialog"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        </div>
        <div className="code-pairing">
          {hasActivePairingCode && (
            <div className="qr-frame">
              <QRCodeSVG
                value={createPairingQrPayload(pairing.address, pairing.code)}
                size={196}
                level="M"
                title="DuoDesk address and six-digit pairing code"
              />
            </div>
          )}
          <div className="pairing-details">
            <div className="pairing-field">
              <span className="pairing-meta-label">IP Address</span>
              <code aria-label="Desktop address and port">
                {pairing.address}
              </code>
            </div>
            {hasActivePairingCode && (
              <div className="pairing-field">
                <span className="pairing-meta-label">Pairing Code</span>
                <strong aria-label="Six-digit verification code">
                  {pairing.code}
                </strong>
              </div>
            )}
          </div>
          {pairing.status && <p role="status">{pairing.status}</p>}
          {waiting && (
            <span className="code-expiry">
              {remaining > 0
                ? `Expires in ${remaining}s`
                : "Code expired. Create a new connection."}
            </span>
          )}
        </div>
        <div className="pairing-modal-actions">
          <Button variant="outline" onClick={onNewCode} disabled={busy}>
            <RefreshCw /> New code
          </Button>
          <Button variant="destructive" onClick={onStop} disabled={busy}>
            <Square /> Stop session
          </Button>
        </div>
      </div>
    </div>
  );
}
