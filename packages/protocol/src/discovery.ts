import { parseDesktopAddress } from "./pairing.ts";

/** DNS-SD service type advertised by a desktop while its pairing code is active. */
export const DISCOVERY_SERVICE_TYPE = "_duodesk._tcp";

/** Raw resolved record from the platform browser. Everything here is untrusted LAN input. */
export type DiscoveryRecord = {
  instance: unknown;
  hosts: unknown;
  port: unknown;
  txt: unknown;
};

export type NearbyDesktop = {
  /** DNS-SD instance name; unique per pairing session. */
  id: string;
  /** Display only. Never used for trust decisions. */
  name: string;
  /** Private IPv4 bootstrap endpoint, same format as manual entry. */
  address: string;
};

export type DiscoveryEvent =
  | { type: "found"; record: DiscoveryRecord }
  | { type: "lost"; instance: unknown };

const MAX_DEVICES = 16;
const instancePattern = /^DuoDesk-[0-9a-f]{8}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Drop control and bidi-override characters so a name cannot spoof layout.
  const clean = Array.from(value)
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return !(
        n < 0x20 ||
        (n >= 0x7f && n <= 0x9f) ||
        n === 0x200e ||
        n === 0x200f ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069)
      );
    })
    .join("")
    .trim();
  return clean ? Array.from(clean).slice(0, max).join("") : null;
}

/** Validates a record; returns null for anything that is not a usable DuoDesk v1 desktop. */
export function parseDiscoveryRecord(
  record: DiscoveryRecord,
): NearbyDesktop | null {
  const { instance, hosts, port, txt } = record ?? {};
  if (typeof instance !== "string" || !instancePattern.test(instance))
    return null;
  if (!txt || typeof txt !== "object" || Array.isArray(txt)) return null;
  const fields = txt as Record<string, unknown>;
  if (fields.v !== "1" || fields.role !== "desktop") return null;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    return null;
  if (!Array.isArray(hosts)) return null;
  // A host can resolve to several addresses; keep the first private IPv4 one.
  for (const host of hosts.slice(0, 8)) {
    if (typeof host !== "string") continue;
    try {
      const address = parseDesktopAddress(`${host}:${port as number}`);
      return {
        id: instance,
        name: text(fields.name, 40) ?? "DuoDesk PC",
        address,
      };
    } catch {
      // IPv6, public or malformed address: try the next one.
    }
  }
  return null;
}

/** Pure list update for found/lost events: dedupes, drops stale sessions, bounds size. */
export function applyDiscoveryEvent(
  list: readonly NearbyDesktop[],
  event: DiscoveryEvent,
): NearbyDesktop[] {
  if (event.type === "lost") return list.filter((d) => d.id !== event.instance);
  const device = parseDiscoveryRecord(event.record);
  // An invalid update for a known instance means it no longer qualifies.
  if (!device) return list.filter((d) => d.id !== event.record?.instance);
  // A new session from the same endpoint replaces an older record.
  const rest = list.filter(
    (d) => d.id !== device.id && d.address !== device.address,
  );
  return [...rest, device]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.address.localeCompare(b.address),
    )
    .slice(0, MAX_DEVICES);
}
