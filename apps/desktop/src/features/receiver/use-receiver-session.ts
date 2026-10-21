import { useEffect, useEffectEvent, useRef, useState } from "react";
import { invoke, isDesktop, subscribe } from "@/shared/host";
import type {
  NetworkAddress,
  ReceiverWorkspaceProps,
} from "./receiver-workspace";
import type { Invitation, StreamState } from "@duodesk/protocol";
import { VideoReceiver, type VideoStats } from "./video-receiver";
import {
  createPairingServer,
  verificationCode,
} from "@duodesk/protocol/pairing";

export function useReceiverSession(): ReceiverWorkspaceProps {
  const [interfaces, setInterfaces] = useState<NetworkAddress[]>([]);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [pairingStatus, setPairingStatus] = useState("");
  const pairing = useRef<
    Awaited<ReturnType<typeof createPairingServer>> | undefined
  >(undefined);
  const [ip, setIp] = useState("");
  const [invitation, setInvitation] = useState<Invitation>();
  const [state, setState] = useState<StreamState>("idle");
  const [error, setError] = useState("");
  const [stats, setStats] = useState<VideoStats>();
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const prefs = useRef({ muted: false, volume: 1 });
  const video = useRef<HTMLVideoElement>(null);
  const peer = useRef<VideoReceiver | undefined>(undefined);
  const current = useRef<Invitation | undefined>(undefined);
  const mounted = useRef(false);

  function release() {
    peer.current?.stop();
    peer.current = undefined;
    if (video.current) video.current.srcObject = null;
    setHasAudio(false);
    setAutoplayBlocked(false);
  }

  /** Creates a fresh peer for the session; the phone sends a new offer each time it shares. */
  function receive(session: Invitation) {
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
        setError(message);
        void stop();
        setState("failed");
      },
      (connection) => {
        if (connection === "connected") setState("streaming");
      },
    );
  }

  // The phone stopped sharing but stays paired: wait for its next offer.
  const onPause = useEffectEvent((session: Invitation) => {
    release();
    setStats(undefined);
    setState("ready");
    receive(session);
  });

  /** Starts playback with the user's sound settings; falls back to muted if the browser requires a gesture. */
  async function play(element: HTMLVideoElement) {
    element.volume = prefs.current.volume;
    element.muted = prefs.current.muted;
    try {
      await element.play();
      return;
    } catch {
      if (!element.muted) {
        element.muted = true;
        setAutoplayBlocked(true);
        try {
          await element.play();
          return;
        } catch {
          // Fall through to the manual play prompt.
        }
      }
    }
    setError("Press play on the video to start playback.");
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
  async function stop() {
    current.current = undefined;
    pairing.current = undefined;
    setCode("");
    setAddress("");
    release();
    setInvitation(undefined);
    setStats(undefined);
    setState("stopped");
    await invoke("stream_stop").catch(() => {});
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
    mounted.current = true;
    if (!isDesktop()) return;
    void invoke<NetworkAddress[]>("stream_interfaces")
      .then((addresses) => {
        if (mounted.current) {
          setInterfaces(addresses);
          setIp("");
        }
      })
      .catch(() => setError("Could not list local network addresses."));
    const subscription = subscribe((payload) => {
      const active = current.current;
      if (!active || !mounted.current) return;
      if (
        payload.kind === "pairingstatus" &&
        payload.sessionId === active.sessionId
      ) {
        setCode("");
        pairing.current = undefined;
        setPairingStatus(
          payload.status === "used"
            ? "Code verified. Waiting for the phone’s encrypted connection."
            : "Code locked after 8 connection attempts. Create a new connection to try again.",
        );
      }
      if (
        payload.kind === "pairing" &&
        payload.sessionId === active.sessionId
      ) {
        const handler = pairing.current;
        if (handler)
          void handler(payload.requestId, payload.message, active)
            .then((reply) => {
              if (current.current === active)
                return invoke("stream_pair_reply", {
                  reply: { requestId: payload.requestId, ...reply },
                });
            })
            .catch(() => {
              if (current.current === active)
                void invoke("stream_pair_reply", {
                  reply: {
                    requestId: payload.requestId,
                    message: "",
                    complete: false,
                  },
                }).catch(() => {});
            });
      }
      if (
        payload.kind === "signal" &&
        payload.signal.sessionId === active.sessionId
      ) {
        if (payload.signal.type === "pause") onPause(active);
        else peer.current?.receive(payload.signal);
      }
      if (payload.kind === "state" && payload.sessionId === active.sessionId) {
        setState(payload.state);
        if (payload.state === "ready") {
          pairing.current = undefined;
          setCode("");
        }
        if (payload.state === "stopped" || payload.state === "failed") {
          release();
          pairing.current = undefined;
          setCode("");
          current.current = undefined;
          setInvitation(undefined);
          if (payload.state === "failed")
            setError(
              "Session expired or disconnected. Check Wi-Fi/firewall and create a new connection.",
            );
        }
      }
    });
    return () => {
      mounted.current = false;
      current.current = undefined;
      pairing.current = undefined;
      release();
      void subscription.then((unlisten) => unlisten());
      void invoke("stream_stop").catch(() => {});
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(
        Math.max(
          0,
          Math.ceil(((current.current?.expiresAt ?? 0) - Date.now()) / 1000),
        ),
      );
      const activePeer = peer.current;
      void activePeer
        ?.stats()
        .then((value) => {
          if (mounted.current && peer.current === activePeer && value)
            setStats(value);
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function refresh() {
    setBusy(true);
    try {
      const addresses = await invoke<NetworkAddress[]>("stream_interfaces");
      setInterfaces(addresses);
      if (!addresses.some((item) => item.address === ip && item.selectable))
        setIp("");
    } catch {
      setError("Could not refresh local addresses.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError("");
    setStats(undefined);
    try {
      await stop();
      const nextCode = verificationCode();
      const handler = await createPairingServer(nextCode);
      const connection = await invoke<{
        invitation: Invitation;
        address: string;
      }>("stream_start", { ip });
      const next = connection.invitation;
      pairing.current = handler;
      setCode(nextCode);
      setPairingStatus("");
      setAddress(connection.address);
      if (!mounted.current) {
        await invoke("stream_stop");
        return;
      }
      current.current = next;
      receive(next);
      setInvitation(next);
      setRemaining(120);
      setState("connecting");
    } catch (cause) {
      await stop();
      setState("failed");
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    desktopAvailable: isDesktop(),
    interfaces,
    ip,
    onIpChange: setIp,
    onRefresh: () => void refresh(),
    invitation,
    pairing: invitation ? { address, code, status: pairingStatus } : undefined,
    state,
    error,
    stats,
    busy,
    remaining,
    videoRef: video,
    audio: {
      present: hasAudio,
      muted,
      volume,
      blocked: autoplayBlocked,
      onMutedChange: changeMuted,
      onVolumeChange: changeVolume,
    },
    onStart: () => void start(),
    onStop: () => void stop(),
    onFullscreen: () => {
      const panel = video.current?.closest(".receiver-panel");
      const action = document.fullscreenElement
        ? document.exitFullscreen()
        : panel?.requestFullscreen();
      void action?.catch(() =>
        setError("Fullscreen is unavailable. Try opening the desktop app."),
      );
    },
  };
}
