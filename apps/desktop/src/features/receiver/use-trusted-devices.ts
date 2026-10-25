import { useEffect, useRef, useState } from "react";
import type { Invitation } from "@duodesk/protocol";
import { invoke, isDesktop, subscribe, type TrustStatus } from "@/shared/host";
import type { TrustedDevicesProps } from "./trusted-devices";

type TrustCommand = "trust_allow" | "trust_approve" | "trust_revoke";

/** Trusted phones, enrollment approvals and the reconnect listener for the receiver. */
export function useTrustedDevices({
  ip,
  canEnable,
  onReconnected,
}: {
  ip: string;
  canEnable: boolean;
  /** A trusted phone proved its key; the host already opened this session. */
  onReconnected: (invitation: Invitation) => void;
}): TrustedDevicesProps {
  const [status, setStatus] = useState<TrustStatus>({
    available: false,
    reason: window.duoDesk
      ? "Checking secure storage…"
      : "Trusted devices require the Electron desktop app.",
    enabled: false,
    address: null,
    fingerprint: null,
    devices: [],
    pending: [],
  });
  const statusRef = useRef(status);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const reconnected = useRef(onReconnected);
  useEffect(() => {
    reconnected.current = onReconnected;
  });

  function update(next: TrustStatus) {
    statusRef.current = next;
    setStatus(next);
  }

  useEffect(() => {
    mounted.current = true;
    if (!isDesktop()) return;
    if (window.duoDesk) {
      void invoke<TrustStatus>("trust_status")
        .then((next) => {
          if (mounted.current) update(next);
        })
        .catch(() => {
          if (mounted.current)
            update({
              ...statusRef.current,
              reason: "Could not read trusted devices. Restart the desktop app.",
            });
        });
    } else {
      update({
        ...statusRef.current,
        reason: "Trusted devices require the Electron desktop app.",
      });
    }
    const subscription = subscribe((payload) => {
      if (!mounted.current) return;
      if (payload.kind === "trust_status") update(payload.status);
      if (payload.kind === "trust_enrollment") {
        const previous = statusRef.current;
        update({
          ...previous,
          pending: [
            ...previous.pending.filter(
              (item) => item.requestId !== payload.request.requestId,
            ),
            payload.request,
          ],
        });
      }
      if (payload.kind === "trust_reconnected") {
        const name =
          statusRef.current.devices.find(
            (device) => device.phoneId === payload.phoneId,
          )?.name ?? "Trusted phone";
        setNotice(
          `${name} reconnected automatically. Waiting for the phone to start sharing.`,
        );
        reconnected.current(payload.invitation);
      }
    });
    return () => {
      mounted.current = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  async function change(command: TrustCommand, args: Record<string, unknown>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await invoke<TrustStatus>(command, args);
      if (mounted.current) update(next);
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not update trusted devices.",
        );
        await invoke<TrustStatus>("trust_status")
          .then(update)
          .catch(() => {});
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return {
    status,
    busy,
    canEnable,
    notice,
    error,
    onAllow: (allow) =>
      void change("trust_allow", {
        ip: allow ? ip : (status.address?.split(":")[0] ?? ip),
        allow,
      }),
    onApprove: (requestId, approve) =>
      void change("trust_approve", { requestId, approve }),
    onRevoke: (phoneId) => void change("trust_revoke", { phoneId }),
  };
}
