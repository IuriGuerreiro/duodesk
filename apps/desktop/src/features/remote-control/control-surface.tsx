import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type RefObject,
} from "react";
import { MousePointerClick, Pause, Play } from "lucide-react";
import {
  containedContent,
  toNormalized,
  videoMatchesDisplay,
  type Rect,
} from "@duodesk/protocol";
import { Button } from "@/shared/ui/button";
import type { ControlLink, ControlView } from "./control-link";
import { controlSummary } from "./copy";
import { GestureRecorder } from "./gesture";

const idle: ControlView = {
  phase: "waiting",
  epoch: -1,
  busy: false,
  paused: false,
  text: false,
};

export function useControlView(link: ControlLink | undefined): ControlView {
  return useSyncExternalStore(
    (notify) => link?.subscribe(notify) ?? (() => {}),
    () => link?.getView() ?? idle,
  );
}

/** Where the video's picture is, in viewport coordinates, with letterbox margins excluded. */
function pictureRect(video: HTMLVideoElement): Rect | undefined {
  const box = video.getBoundingClientRect();
  const inner = containedContent(
    box.width,
    box.height,
    video.videoWidth,
    video.videoHeight,
  );
  return (
    inner && { ...inner, left: box.left + inner.left, top: box.top + inner.top }
  );
}

interface Picture {
  /** Position inside the stage that holds the video. */
  left: number;
  top: number;
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
}

/**
 * Follows the picture through resizes, fullscreen and rotation. Measuring happens in observer callbacks,
 * never during render, because it reads the live layout.
 */
function usePicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): Picture | undefined {
  const [picture, setPicture] = useState<Picture>();
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled) return;
    const measure = () => {
      const picture = pictureRect(video);
      const stage = video.parentElement?.getBoundingClientRect();
      if (!picture || !stage) return setPicture(undefined);
      setPicture({
        left: picture.left - stage.left,
        top: picture.top - stage.top,
        width: picture.width,
        height: picture.height,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      });
    };
    // Observing reports the first size straight away.
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener("resize", measure);
    video.addEventListener("loadedmetadata", measure);
    document.addEventListener("fullscreenchange", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", measure);
      video.removeEventListener("loadedmetadata", measure);
      document.removeEventListener("fullscreenchange", measure);
    };
  }, [videoRef, enabled]);
  return enabled ? picture : undefined;
}

/** True when the picture has the shape of the screen the phone reported. */
function agrees(view: ControlView, picture: Picture | undefined) {
  return (
    !!picture &&
    !!view.geometry &&
    videoMatchesDisplay(view.geometry, picture.videoWidth, picture.videoHeight)
  );
}

/**
 * Transparent layer exactly over the picture. It exists only while the phone has allowed control, so black
 * margins and an unauthorised phone never receive clicks.
 */
export function ControlSurface({
  link,
  videoRef,
}: {
  link: ControlLink | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const view = useControlView(link);
  const open = view.phase === "active";
  const picture = usePicture(videoRef, open);
  const recorder = useRef(new GestureRecorder());
  const epoch = useRef(-1);

  useEffect(() => {
    if (open) return;
    recorder.current.cancel();
  }, [open]);

  useEffect(() => {
    const cancel = () => recorder.current.cancel();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && cancel();
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!link || !open || !picture || !agrees(view, picture)) return null;

  const locate = (event: PointerEvent) => {
    const current = videoRef.current && pictureRect(videoRef.current);
    return current && toNormalized(event.clientX, event.clientY, current);
  };

  return (
    <div
      className="control-surface"
      style={{
        left: picture.left,
        top: picture.top,
        width: picture.width,
        height: picture.height,
      }}
      onPointerDown={(event) => {
        // Only the primary button of the primary pointer; right and middle clicks do nothing.
        if (event.button !== 0 || !event.isPrimary) return;
        const point = locate(event);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        epoch.current = link.currentEpoch();
        recorder.current.begin(
          point,
          event.clientX,
          event.clientY,
          performance.now(),
        );
      }}
      onPointerMove={(event) => {
        if (!recorder.current.active) return;
        const point = locate(event);
        if (point) recorder.current.move(point, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (!recorder.current.active || event.button !== 0) return;
        const point = locate(event);
        const element = videoRef.current;
        const gesture = point
          ? recorder.current.end(
              point,
              event.clientX,
              event.clientY,
              performance.now(),
            )
          : (recorder.current.cancel(), { kind: "ignored" as const });
        if (!element || gesture.kind === "ignored") return;
        const size = { width: element.videoWidth, height: element.videoHeight };
        if (gesture.kind === "tap")
          link.tap(gesture.point, epoch.current, size);
        else
          link.swipe(gesture.points, gesture.durationMs, epoch.current, size);
      }}
      onPointerCancel={() => recorder.current.cancel()}
      onLostPointerCapture={() => recorder.current.cancel()}
      // Tapping the phone must not take focus from the typing composer.
      onMouseDown={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      aria-label="Phone screen. Click to tap, drag to swipe."
      role="application"
    />
  );
}

/** Toolbar status line and the local pause switch. */
export function ControlStatus({
  link,
  videoRef,
}: {
  link: ControlLink | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const view = useControlView(link);
  const picture = usePicture(videoRef, view.phase === "active");
  if (!link) return null;
  const mismatch = view.phase === "active" && !agrees(view, picture);
  const allowed =
    view.phase === "active" ||
    view.phase === "paused" ||
    view.phase === "syncing";
  const summary = controlSummary(view, mismatch);
  const labels: Record<ControlView["phase"], string> = {
    active: "Remote access",
    paused: "Control paused",
    syncing: "Syncing control…",
    waiting: "View only",
    off: "View only",
  };
  const label = mismatch ? labels.syncing : labels[view.phase];
  return (
    <div className="control-status" role="group" aria-label="Phone control">
      <MousePointerClick size={14} aria-hidden />
      <span role="status" title={summary} aria-label={summary}>
        {label}
      </span>
      {allowed && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => link.setPaused(!view.paused)}
          aria-pressed={view.paused}
        >
          {view.paused ? <Play /> : <Pause />}
          {view.paused ? "Resume" : "Pause"}
        </Button>
      )}
    </div>
  );
}
