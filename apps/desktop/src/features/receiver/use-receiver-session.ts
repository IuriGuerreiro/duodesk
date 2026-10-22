import { useEffect, useRef, useState } from "react";
import { invoke } from "@/shared/host";
import {
  useStreamSession,
  type SessionControl,
} from "@/shared/session/use-stream-session";
import type { Invitation } from "@duodesk/protocol";
import type { ReceiverWorkspaceProps } from "./receiver-workspace";
import { VideoReceiver, type VideoStats } from "./video-receiver";

export function useReceiverSession(): ReceiverWorkspaceProps {
  const [stats, setStats] = useState<VideoStats>();
  const [hasAudio, setHasAudio] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const prefs = useRef({ muted: false, volume: 1 });
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<VideoReceiver | undefined>(undefined);
  const control = useRef<SessionControl | undefined>(undefined);

  function release() {
    peer.current?.stop();
    peer.current = undefined;
    if (video.current) video.current.srcObject = null;
    setPlaybackFailed(false);
    setHasAudio(false);
    setAutoplayBlocked(false);
  }

  /** Creates a fresh peer for the session; the phone sends a new offer each time it shares. */
  function receive(session: Pick<Invitation, "sessionId">) {
    peer.current = new VideoReceiver(
      session.sessionId,
      (signal) => invoke("stream_send", { signal }),
      (stream) => {
        const element = video.current;
        if (!element) return;
        if (element.srcObject !== stream) element.srcObject = stream;
        setHasAudio(stream.getAudioTracks().length > 0);
        void play(element);
      },
      (message) => {
        control.current?.fail(message);
      },
      (connection) => {
        if (connection === "connected") control.current?.setState("streaming");
      },
    );
  }

  const session = useStreamSession({
    direction: "phone-to-desktop",
    onStarted: (invitation, next) => {
      control.current = next;
      setStats(undefined);
      receive(invitation);
    },
    onSignal: (signal) => {
      if (signal.type === "pause") {
        release();
        setStats(undefined);
        control.current?.setState("ready");
        // The link stays paired; the next share creates a fresh offer.
        receive({ sessionId: signal.sessionId });
      } else void peer.current?.receive(signal);
    },
    onEnded: () => {
      release();
      control.current = undefined;
      setStats(undefined);
    },
  });

  /** Starts playback with the user's sound settings; falls back to muted if the browser requires a gesture. */
  async function play(element: HTMLVideoElement) {
    const media = element.srcObject;
    element.volume = prefs.current.volume;
    element.muted = prefs.current.muted;
    try {
      await element.play();
      if (element.srcObject === media) setPlaybackFailed(false);
      return;
    } catch {
      if (element.srcObject !== media) return;
      if (!element.muted) {
        element.muted = true;
        setAutoplayBlocked(true);
        try {
          await element.play();
          if (element.srcObject === media) setPlaybackFailed(false);
          return;
        } catch {
          // Fall through to the manual play prompt.
        }
      }
    }
    if (element.srcObject === media) setPlaybackFailed(true);
  }

  function changeMuted(next: boolean) {
    const element = video.current;
    prefs.current.muted = next;
    if (!element) return;
    element.muted = next;
    if (!next) {
      setAutoplayBlocked(false);
      if (element.paused && element.srcObject) void play(element);
    }
  }

  function changeVolume(next: number) {
    const element = video.current;
    prefs.current.volume = next;
    if (!element) return;
    element.volume = next;
    // Dragging the slider up is an explicit request to hear audio.
    if (next > 0 && element.muted) changeMuted(false);
  }
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    // Keep React state in step with the player's own controls.
    const sync = () => {
      prefs.current = { muted: element.muted, volume: element.volume };
      setMuted(element.muted);
      setVolume(element.volume);
    };
    element.addEventListener("volumechange", sync);
    return () => element.removeEventListener("volumechange", sync);
  }, []);

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
    playbackFailed,
    onPlay: () => {
      if (video.current) void play(video.current);
    },
    audio: {
      present: hasAudio,
      muted,
      volume,
      blocked: autoplayBlocked,
      onMutedChange: changeMuted,
      onVolumeChange: changeVolume,
    },
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
