import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_STREAM_SETTINGS,
  parseStreamSettings,
  type StreamSettings,
} from "@duodesk/protocol";
import { invoke } from "@/shared/host";
import {
  useStreamSession,
  type SessionControl,
} from "@/shared/session/use-stream-session";
import type { ScreenShareWorkspaceProps } from "./screen-share-workspace";
import { ScreenSender, type ScreenStats } from "./screen-sender";

const RETRYABLE = ["NotAllowedError", "NotFoundError", "AbortError"];

export function useScreenShareSession(
  rememberedRequestId?: string,
): Omit<ScreenShareWorkspaceProps, "onReceive"> {
  const [stats, setStats] = useState<ScreenStats>();
  const [sharing, setSharing] = useState(false);
  const peer = useRef<ScreenSender | undefined>(undefined);
  const control = useRef<SessionControl | undefined>(undefined);
  const [settingsText, setSettingsText] = useState({
    maxLongSide: String(DEFAULT_STREAM_SETTINGS.maxLongSide),
    maxShortSide: String(DEFAULT_STREAM_SETTINGS.maxShortSide),
    frameRate: String(DEFAULT_STREAM_SETTINGS.frameRate),
  });
  const parsed = parseStreamSettings(settingsText);
  /** Settings are fixed when the connection is created, so a session never changes them underneath the phone. */
  const chosen = useRef<StreamSettings>(DEFAULT_STREAM_SETTINGS);

  const session = useStreamSession({
    rememberedRequestId,
    direction: "desktop-to-phone",
    onReady: () => void share(),
    onSignal: (signal) => peer.current?.receive(signal),
    onStarted: (invitation, next) => {
      control.current = next;
      setSharing(false);
      setStats(undefined);
      peer.current = new ScreenSender(
        invitation.sessionId,
        (signal) => invoke("stream_send", { signal }),
        next.fail,
        (connection) => {
          if (connection === "connected") next.setState("streaming");
        },
        chosen.current,
        next.recover,
      );
    },
    onEnded: () => {
      peer.current?.stop();
      peer.current = undefined;
      control.current = undefined;
      setSharing(false);
      setStats(undefined);
    },
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const activePeer = peer.current;
      void activePeer
        ?.stats()
        .then((value) => {
          if (peer.current === activePeer && value) setStats(value);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  /** Pairing starts capture automatically; the button retries a failed capture. */
  async function share() {
    const active = peer.current;
    if (!active || sharing) return;
    setSharing(true);
    try {
      await active.start();
    } catch (cause) {
      if (peer.current !== active) return;
      const name = cause instanceof DOMException ? cause.name : "";
      if (RETRYABLE.includes(name)) {
        setSharing(false);
        session.setError(
          `Screen capture failed (${name}): ${cause instanceof Error ? cause.message : "Unknown error"}. Choose Retry sharing to try again.`,
        );
      } else
        control.current?.fail(
          cause instanceof Error
            ? cause.message
            : "Could not share the screen.",
        );
    }
  }

  return {
    desktopAvailable: session.desktopAvailable,
    interfaces: session.interfaces,
    ip: session.ip,
    onIpChange: session.onIpChange,
    onRefresh: session.onRefresh,
    invitation: session.invitation,
    pairing: session.pairing,
    state: session.state,
    error: session.error,
    stats,
    recovery: session.recovery,
    onReconnect: () => peer.current?.reconnect(),
    sharing,
    busy: session.busy,
    remaining: session.remaining,
    settings: settingsText,
    settingsError: parsed.ok ? "" : parsed.error,
    onSettingsChange: (next) =>
      setSettingsText((current) => ({ ...current, ...next })),
    onStart: () => {
      if (!parsed.ok) return;
      chosen.current = parsed.settings;
      session.onStart();
    },
    onStop: session.onStop,
    onShare: () => void share(),
  };
}
