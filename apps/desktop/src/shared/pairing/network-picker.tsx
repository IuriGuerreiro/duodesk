import { RefreshCw } from "lucide-react";
import type { NetworkAddress } from "@/shared/host";
import { Button } from "@/shared/ui/button";

export interface NetworkPickerProps {
  desktopAvailable: boolean;
  busy: boolean;
  interfaces: NetworkAddress[];
  ip: string;
  onIpChange: (ip: string) => void;
  onRefresh: () => void;
}

export function NetworkPicker({
  desktopAvailable,
  busy,
  interfaces,
  ip,
  onIpChange,
  onRefresh,
}: NetworkPickerProps) {
  const hasSelectableAddress = interfaces.some((address) => address.selectable);
  return (
    <div className="network-settings">
      <label className="field-label" htmlFor="desktop-address">
        Desktop address
      </label>
      <select
        id="desktop-address"
        value={ip}
        onChange={(e) => onIpChange(e.target.value)}
        disabled={busy || !hasSelectableAddress}
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
        disabled={!desktopAvailable || busy}
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
    </div>
  );
}
