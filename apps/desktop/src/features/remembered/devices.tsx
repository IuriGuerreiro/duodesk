import { useEffect, useRef, useState } from "react";
import type { Direction } from "@duodesk/protocol";
import {
  invoke,
  subscribe,
  isDesktop,
  type NetworkAddress,
} from "@/shared/host";
import type { TrustEvent, TrustStatus } from "@/shared/host/trust-types";

export function RememberedDevices({
  onStart,
}: {
  onStart: (direction: Direction, requestId: string) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TrustStatus>();
  const [interfaces, setInterfaces] = useState<NetworkAddress[]>([]);
  const [ip, setIp] = useState("");
  const [name, setName] = useState("");
  const [enroll, setEnroll] =
    useState<Extract<TrustEvent, { type: "enroll" }>>();
  const [request, setRequest] =
    useState<Extract<TrustEvent, { type: "request" | "accepted" }>>();
  const [outgoing, setOutgoing] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isDesktop()) return;
    let live = true;
    void Promise.all([
      invoke<TrustStatus>("trust_status"),
      invoke<NetworkAddress[]>("stream_interfaces"),
    ])
      .then(([s, list]) => {
        if (live) {
          setStatus(s);
          setInterfaces(list);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    const off = subscribe((event) => {
      if (!live) return;
      if (
        event.kind === "state" &&
        ["stopped", "failed", "disconnected"].includes(event.state)
      )
        setEnroll(undefined);
      if (event.kind !== "trust") return;
      if (event.type === "status") setStatus(event.status);
      if (event.type === "enroll") {
        setEnroll(event);
        if (event.state === "incoming") {
          setName(event.peerName ?? "Phone");
          setOpen(true);
          section.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      }
      if (event.type === "request") setRequest(event);
      if (event.type === "accepted") {
        setOutgoing(undefined);
        setRequest(undefined);
        onStart(event.direction, event.requestId);
      }
      if (event.type === "cancelled" || event.type === "rejected") {
        setOutgoing((id) => (id === event.requestId ? undefined : id));
        setRequest((request) =>
          request?.requestId === event.requestId ? undefined : request,
        );
        setError(
          "Connection request ended. Connect again when both devices are ready.",
        );
      }
    });
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [onStart]);
  useEffect(() => {
    if (request?.type === "request") dialog.current?.showModal();
    else dialog.current?.close();
  }, [request]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }
  async function connect(deviceId: string, direction: Direction) {
    setOutgoing(await invoke<string>("trust_connect", { deviceId, direction }));
  }
  async function respond(accept: boolean) {
    if (!request) return;
    try {
      await invoke("trust_respond", { requestId: request.requestId, accept });
      if (accept) onStart(request.direction, request.requestId);
    } finally {
      setRequest(undefined);
    }
  }
  if (!isDesktop()) return null;
  return (
    <section
      ref={section}
      className="remembered-devices"
      aria-label="Remembered devices"
    >
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          Remembered devices{" "}
          {status?.devices.length ? `(${status.devices.length})` : ""}
        </summary>
        <p>
          Trust skips the pairing code. Each new session still needs approval.
          Open DuoDesk on both devices.
        </p>
        {status?.error && <p role="status">{status.error}</p>}
        <label>
          Remembered-device network{" "}
          <select
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            disabled={busy || !status?.available}
          >
            <option value="">Choose a local network</option>
            {interfaces
              .filter((a) => a.selectable && a.kind !== "tailscale")
              .map((a) => (
                <option key={a.address} value={a.address}>
                  {a.name} · {a.address}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={busy || !ip || !status?.available}
          onClick={() => void run(() => invoke("trust_endpoint", { ip }))}
        >
          Enable remembered connections
        </button>
        <button
          disabled={busy || !status?.endpoint}
          onClick={() => void run(() => invoke("trust_endpoint", { ip: null }))}
        >
          Turn off
        </button>
        {status?.endpoint && (
          <p>
            {status.endpoint.listening
              ? `Listening on ${status.endpoint.address}`
              : (status.endpoint.error ?? "Network unavailable")}
          </p>
        )}
        <label>
          Device name{" "}
          <input
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My phone"
          />
        </label>
        {enroll?.state === "incoming" ? (
          <>
            <p>Remember {enroll.peerName}? This only saves identity.</p>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  invoke("trust_enroll", { action: "approve", name }),
                )
              }
            >
              Remember this device
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(() => invoke("trust_enroll", { action: "reject" }))
              }
            >
              Decline
            </button>
          </>
        ) : (
          <button
            disabled={busy || enroll?.state !== "capable"}
            onClick={() =>
              void run(() => invoke("trust_enroll", { action: "start", name }))
            }
          >
            Remember paired device
          </button>
        )}
        {enroll && (
          <p role="status">
            {enroll.message ??
              {
                capable: "The paired phone supports remembering.",
                requested: "Waiting for the phone's approval.",
                verifying: "Saving mutual trust…",
                saved: "Device remembered.",
                failed: "Could not remember. Pair again to retry.",
                cancelled: "Remember request cancelled.",
              }[enroll.state] ??
              ""}
          </p>
        )}
        {!status?.devices.length && (
          <p>No remembered devices. Pair first, then choose Remember.</p>
        )}
        {status?.devices.map((device) => (
          <div key={device.id} className="remembered-device">
            <strong>{device.name}</strong>{" "}
            <span>
              {device.available ? "Available" : "Open DuoDesk on the phone"}
            </span>
            <button
              disabled={busy || !!outgoing || !device.available}
              onClick={() =>
                void run(() => connect(device.id, "phone-to-desktop"))
              }
            >
              View phone
            </button>
            <button
              disabled={busy || !!outgoing || !device.available}
              onClick={() =>
                void run(() => connect(device.id, "desktop-to-phone"))
              }
            >
              Share desktop
            </button>
            <button
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(() =>
                  invoke("trust_rename", { deviceId: device.id, name }),
                )
              }
            >
              Rename using name above
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(() => invoke("trust_forget", { deviceId: device.id }))
              }
            >
              Forget
            </button>
          </div>
        ))}
        {outgoing && (
          <p role="status">
            Waiting for the phone's approval.{" "}
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  try {
                    await invoke("trust_cancel", { requestId: outgoing });
                  } finally {
                    setOutgoing(undefined);
                  }
                })
              }
            >
              Cancel request
            </button>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
      {request?.type === "request" && (
        <dialog
          ref={dialog}
          onCancel={(e) => {
            e.preventDefault();
            void run(() => respond(false));
          }}
        >
          <p>
            {status?.devices.find((d) => d.id === request.deviceId)?.name ??
              "Phone"}{" "}
            requests{" "}
            {request.direction === "desktop-to-phone"
              ? "viewing your desktop"
              : "sharing its screen"}
            .
          </p>
          <button disabled={busy} onClick={() => void run(() => respond(true))}>
            Accept session
          </button>
          <button
            disabled={busy}
            onClick={() => void run(() => respond(false))}
          >
            Decline
          </button>
        </dialog>
      )}
    </section>
  );
}
