import { useEffect, useRef, useState } from "react";
import { invoke } from "@/shared/host";
import {
  useStreamSession,
  type SessionControl,
} from "@/shared/session/use-stream-session";
import type { ScreenShareWorkspaceProps } from "./screen-share-workspace";
import { ScreenSender, type ScreenStats } from "./screen-sender";

const RETRYABLE = ["NotAllowedError", "NotFoundError", "AbortError"];

export function useScreenShareSession(): ScreenShareWorkspaceProps {
  const [stats, setStats] = useState<ScreenStats>();
  const [sharing, setSharing] = useState(false);
  const peer = useRef<ScreenSender | undefined>(undefined);
  const control = useRef<SessionControl | undefined>(undefined);

  const session = useStreamSession({
    direction: "desktop-to-phone",
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

  /** Runs from the Start sharing click, which is the user gesture capture needs. */
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
          "Screen capture was not allowed. Choose Start sharing to try again.",
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
    sharing,
    busy: session.busy,
    remaining: session.remaining,
    onStart: session.onStart,
    onStop: session.onStop,
    onShare: () => void share(),
  };
}
