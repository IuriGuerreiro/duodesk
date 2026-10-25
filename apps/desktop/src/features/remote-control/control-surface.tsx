import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  Circle,
  MousePointerClick,
  Pause,
  Play,
  Square,
} from "lucide-react";
import {
  containedContent,
  NAV_ACTIONS,
  toNormalized,
  videoMatchesDisplay,
  type NavAction,
  type Rect,
} from "@duodesk/protocol";
import { Button } from "@/shared/ui/button";
import type { ControlLink, ControlView } from "./control-link";
import { controlSummary, navBlocked, navLabels, navSummary } from "./copy";
import { GestureRecorder } from "./gesture";
import { WheelScroller } from "./wheel";

const idle: ControlView = {
  phase: "waiting",
  epoch: -1,
  busy: false,
  paused: false,
};

const navIcons: Record<NavAction, typeof ArrowLeft> = {
  back: ArrowLeft,
  home: Circle,
  recents: Square,
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
  const scroller = useRef<WheelScroller>(undefined);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!link) return;
    const wheel = new WheelScroller(link);
    scroller.current = wheel;
    return () => {
      wheel.close();
      scroller.current = undefined;
    };
  }, [link]);

  useEffect(() => {
    if (open) return;
    recorder.current.cancel();
    scroller.current?.clear();
  }, [open]);

  // React's onWheel is passive, so it cannot stop the desktop page scrolling. Bind natively instead.
  useEffect(() => {
    const video = videoRef.current;
    if (!surface || !link || !video) return;
    const onWheel = (event: WheelEvent) => {
      // Ctrl+wheel is a pinch or desktop zoom; leave it to the desktop.
      if (event.ctrlKey) return;
      event.preventDefault();
      // A press in progress owns the phone; a scroll must not race it.
      if (recorder.current.active) return scroller.current?.clear();
      const rect = pictureRect(video);
      const point = rect && toNormalized(event.clientX, event.clientY, rect);
      if (!rect || !point) return scroller.current?.clear();
      scroller.current?.wheel(event, point, rect, {
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    const leave = () => scroller.current?.clear();
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointerleave", leave);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointerleave", leave);
      // The layer goes away on pause, a shape mismatch or teardown.
      scroller.current?.clear();
    };
  }, [surface, link, videoRef]);

  useEffect(() => {
    const cancel = () => {
      recorder.current.cancel();
      scroller.current?.clear();
    };
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
      ref={setSurface}
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
        scroller.current?.clear();
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
      onContextMenu={(event) => event.preventDefault()}
      aria-label="Phone screen. Click to tap, drag to swipe, use the wheel to scroll."
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
      {allowed && <NavButtons link={link} view={view} />}
    </div>
  );
}

/** Android Back, Home and Recents. Buttons only: desktop keyboard shortcuts are left alone. */
function NavButtons({ link, view }: { link: ControlLink; view: ControlView }) {
  const summary = navSummary(view);
  return (
    <div
      className="control-nav"
      role="group"
      aria-label="Phone navigation buttons"
    >
      {NAV_ACTIONS.map((action) => {
        const Icon = navIcons[action];
        const blocked = navBlocked(view, action);
        return (
          <Button
            key={action}
            variant="ghost"
            size="sm"
            disabled={!!blocked}
            title={blocked ?? `Phone ${navLabels[action]}`}
            aria-label={`Phone ${navLabels[action]}`}
            onClick={() => link.navigate(action)}
          >
            <Icon aria-hidden />
            {navLabels[action]}
          </Button>
        );
      })}
      <span className="control-nav-result" role="status">
        {summary}
      </span>
    </div>
  );
}
