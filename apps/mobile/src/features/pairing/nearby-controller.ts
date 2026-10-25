import {
  applyDiscoveryEvent,
  type NearbyDesktop,
} from "@duodesk/protocol/discovery";

export type NearbyStatus =
  | "idle"
  | "needs-permission"
  | "searching"
  | "denied"
  | "unsupported"
  | "error";

export type NearbyState = { status: NearbyStatus; devices: NearbyDesktop[] };

export type NearbyPlatform = {
  supported: boolean;
  /** Resolves true when browsing is allowed without asking. */
  hasPermission: () => Promise<boolean>;
  /** Shows the system prompt; resolves false if denied. */
  requestPermission: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  subscribe: (listener: (event: Record<string, unknown>) => void) => {
    remove(): void;
  };
};

/**
 * Owns the browse lifecycle: permission, start/stop, event validation and the
 * device list. Every start bumps a generation so late events from an older
 * browse never reach the list. Discovery only fills the address; the user
 * still enters the code shown on the PC.
 */
export function createNearbyController(
  platform: NearbyPlatform,
  onChange: (state: NearbyState) => void,
) {
  let state: NearbyState = {
    status: platform.supported ? "idle" : "unsupported",
    devices: [],
  };
  let generation = 0;
  let subscription: { remove(): void } | null = null;
  const set = (next: Partial<NearbyState>) => {
    state = { ...state, ...next };
    onChange(state);
  };

  function detach() {
    generation += 1;
    subscription?.remove();
    subscription = null;
  }

  async function run(ask: boolean) {
    if (!platform.supported) return set({ status: "unsupported" });
    detach();
    const epoch = generation;
    const stale = () => epoch !== generation;
    try {
      const allowed =
        (await platform.hasPermission()) ||
        (ask && (await platform.requestPermission()));
      if (stale()) return;
      if (!allowed) return set({ status: ask ? "denied" : "needs-permission" });
      set({ status: "searching", devices: [] });
      subscription = platform.subscribe((event) => {
        if (stale()) return;
        if (event.type === "state") {
          if (event.state === "error") set({ status: "error" });
          else if (event.state === "unsupported")
            set({ status: "unsupported" });
          return;
        }
        if (event.type === "found")
          set({
            devices: applyDiscoveryEvent(state.devices, {
              type: "found",
              record: {
                instance: event.instance,
                hosts: event.hosts,
                port: event.port,
                txt: event.txt,
              },
            }),
          });
        else if (event.type === "lost")
          set({
            devices: applyDiscoveryEvent(state.devices, {
              type: "lost",
              instance: event.instance,
            }),
          });
      });
      await platform.start();
    } catch {
      if (!stale()) set({ status: "error" });
    }
  }

  return {
    get state() {
      return state;
    },
    /** Starts browsing if already allowed; never prompts. */
    begin: () => run(false),
    /** User asked: prompt for permission if needed, then browse. */
    retry: () => run(true),
    /** Stops browsing and clears devices (background, leaving, connected). */
    end() {
      detach();
      if (platform.supported) void platform.stop().catch(() => {});
      set({
        status: platform.supported ? "idle" : "unsupported",
        devices: [],
      });
    },
  };
}
