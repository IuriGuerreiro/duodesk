import { useEffect, useRef, useState } from "react";
import { useStreamSession } from "@/shared/session/use-stream-session";
import type { ReceiverWorkspaceProps } from "./receiver-workspace";
import { VideoReceiver, type VideoStats } from "./video-receiver";
import { invoke } from "@/shared/host";

export function useReceiverSession(): ReceiverWorkspaceProps {
  const [stats, setStats] = useState<VideoStats>();
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<VideoReceiver | undefined>(undefined);
  const setError = useRef<(message: string) => void>(() => {});

  const session = useStreamSession({
    direction: "phone-to-desktop",
    onSignal: (signal) => peer.current?.receive(signal),
    onStarted: (invitation, control) => {
      setStats(undefined);
      peer.current = new VideoReceiver(
        invitation.sessionId,
        (signal) => invoke("stream_send", { signal }),
        (stream) => {
          if (video.current) {
            video.current.srcObject = stream;
            void video.current
              .play()
              .catch(() =>
                setError.current("Press play on the video to start playback."),
              );
          }
        },
        control.fail,
        (connection) => {
          if (connection === "connected") control.setState("streaming");
        },
      );
    },
    onEnded: () => {
      peer.current?.stop();
      peer.current = undefined;
      if (video.current) video.current.srcObject = null;
      setStats(undefined);
    },
  });
  useEffect(() => {
    setError.current = session.setError;
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
    busy: session.busy,
    remaining: session.remaining,
    videoRef: video,
    onStart: session.onStart,
    onStop: session.onStop,
    onFullscreen: () => {
      const panel = video.current?.closest(".receiver-panel");
      const action = document.fullscreenElement
        ? document.exitFullscreen()
        : panel?.requestFullscreen();
      void action?.catch(() =>
        session.setError(
          "Fullscreen is unavailable. Try opening the desktop app.",
        ),
      );
    },
  };
}
