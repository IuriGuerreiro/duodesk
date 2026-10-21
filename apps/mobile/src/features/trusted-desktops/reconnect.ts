export type ReconnectFailure = {
  kind: "transient" | "terminal";
  message: string;
};
type Target = { fingerprint: string; attempt: number };
export type ReconnectState =
  | { kind: "idle" }
  | ({ kind: "connecting" } & Target)
  | ({ kind: "waiting"; delayMs: number; message: string } & Target)
  | ({ kind: "failed"; terminal: boolean; message: string } & Target)
  | { kind: "connected" | "cancelled"; fingerprint: string };
export type ReconnectEvent =
  | { kind: "begin"; fingerprint: string }
  | { kind: "failure"; failure: ReconnectFailure }
  | { kind: "retry" }
  | { kind: "connected" }
  | { kind: "cancel" };

const RETRY_DELAYS = [1000, 2000, 4000];

export function reconnectReducer(
  state: ReconnectState,
  event: ReconnectEvent,
): ReconnectState {
  switch (event.kind) {
    case "begin":
      return { kind: "connecting", fingerprint: event.fingerprint, attempt: 0 };
    case "failure": {
      if (state.kind !== "connecting") return state;
      const delayMs = RETRY_DELAYS[state.attempt];
      if (event.failure.kind === "transient" && delayMs !== undefined) {
        return {
          ...state,
          kind: "waiting",
          delayMs,
          message: event.failure.message,
        };
      }
      return {
        ...state,
        kind: "failed",
        terminal: event.failure.kind === "terminal",
        message: event.failure.message,
      };
    }
    case "retry":
      return state.kind === "waiting"
        ? {
            kind: "connecting",
            fingerprint: state.fingerprint,
            attempt: state.attempt + 1,
          }
        : state;
    case "connected":
      return state.kind === "connecting"
        ? { kind: "connected", fingerprint: state.fingerprint }
        : state;
    case "cancel":
      return "fingerprint" in state
        ? { kind: "cancelled", fingerprint: state.fingerprint }
        : state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function reconnectFailure(error: unknown): ReconnectFailure {
  return {
    kind:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_TRUST_NETWORK"
        ? "transient"
        : "terminal",
    message:
      error instanceof Error
        ? error.message
        : "Remembered access failed. Pair with a new code.",
  };
}

export function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Owns one user's reconnect request, including its bounded retry sequence. */
export function createReconnectFlow(deps: {
  request: (fingerprint: string) => Promise<string>;
  connect: (invitation: string) => Promise<void>;
  close: () => Promise<void>;
  onState: (state: ReconnectState) => void;
  delay?: typeof retryDelay;
}) {
  let state: ReconnectState = { kind: "idle" };
  let current: AbortController | null = null;
  const emit = (event: ReconnectEvent) => {
    state = reconnectReducer(state, event);
    deps.onState(state);
  };
  return {
    async run(fingerprint: string) {
      if (current) return;
      const controller = new AbortController();
      current = controller;
      const stale = () => controller.signal.aborted || current !== controller;
      emit({ kind: "begin", fingerprint });
      try {
        while (!stale()) {
          try {
            const invitation = await deps.request(fingerprint);
            if (stale()) return;
            await deps.connect(invitation);
            if (!stale()) emit({ kind: "connected" });
            return;
          } catch (error) {
            if (stale()) return;
            emit({ kind: "failure", failure: reconnectFailure(error) });
            if (state.kind !== "waiting") return;
            await (deps.delay ?? retryDelay)(state.delayMs, controller.signal);
            if (stale()) return;
            emit({ kind: "retry" });
          }
        }
      } finally {
        if (current === controller) current = null;
      }
    },
    cancel() {
      current?.abort();
      current = null;
      emit({ kind: "cancel" });
      return deps.close();
    },
  };
}
