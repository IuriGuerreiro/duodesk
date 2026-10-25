/** Pure layout math for the desktop viewer. The native view is sized by these frames, so frames never cross JS. */

export type FitMode = "fit" | "fill";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Viewport {
  mode: FitMode;
  zoom: number;
  offset: Point;
}

export interface Frame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export const initialViewport = (mode: FitMode = "fit"): Viewport => ({
  mode,
  zoom: MIN_ZOOM,
  offset: { x: 0, y: 0 },
});

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const valid = (size: Size) => size.width > 0 && size.height > 0;

/** The video's size at zoom 1: fit shows the whole desktop, fill covers the screen and crops. */
export function baseSize(container: Size, video: Size, mode: FitMode): Size {
  if (!valid(container)) return { width: 0, height: 0 };
  if (!valid(video)) return container;
  const pick = mode === "fit" ? Math.min : Math.max;
  const scale = pick(
    container.width / video.width,
    container.height / video.height,
  );
  return { width: video.width * scale, height: video.height * scale };
}

/** Keeps zoom in range and the video edge from pulling away from the screen edge. */
export function clampViewport(
  viewport: Viewport,
  container: Size,
  video: Size,
): Viewport {
  const zoom = clamp(viewport.zoom, MIN_ZOOM, MAX_ZOOM);
  const base = baseSize(container, video, viewport.mode);
  const maxX = Math.max(0, (base.width * zoom - container.width) / 2);
  const maxY = Math.max(0, (base.height * zoom - container.height) / 2);
  return {
    mode: viewport.mode,
    zoom,
    offset: {
      x: clamp(viewport.offset.x, -maxX, maxX) || 0,
      y: clamp(viewport.offset.y, -maxY, maxY) || 0,
    },
  };
}

export function frameFor(
  viewport: Viewport,
  container: Size,
  video: Size,
): Frame {
  const base = baseSize(container, video, viewport.mode);
  const width = base.width * viewport.zoom;
  const height = base.height * viewport.zoom;
  return {
    left: (container.width - width) / 2 + viewport.offset.x,
    top: (container.height - height) / 2 + viewport.offset.y,
    width,
    height,
  };
}

/** Zooms around the pinch midpoint so the desktop content under the fingers stays put. */
export function pinch(
  start: Viewport,
  container: Size,
  video: Size,
  gesture: {
    startDistance: number;
    distance: number;
    startCenter: Point;
    center: Point;
  },
): Viewport {
  if (gesture.startDistance <= 0) return start;
  const zoom = clamp(
    (start.zoom * gesture.distance) / gesture.startDistance,
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const ratio = zoom / start.zoom;
  const cx = container.width / 2;
  const cy = container.height / 2;
  const anchorX = gesture.startCenter.x - cx - start.offset.x;
  const anchorY = gesture.startCenter.y - cy - start.offset.y;
  return clampViewport(
    {
      mode: start.mode,
      zoom,
      offset: {
        x: gesture.center.x - cx - anchorX * ratio,
        y: gesture.center.y - cy - anchorY * ratio,
      },
    },
    container,
    video,
  );
}

export function pan(
  start: Viewport,
  container: Size,
  video: Size,
  delta: Point,
): Viewport {
  return clampViewport(
    {
      ...start,
      offset: { x: start.offset.x + delta.x, y: start.offset.y + delta.y },
    },
    container,
    video,
  );
}

/** Switching fit/fill resets zoom and pan so the new mode starts from a known view. */
export const toggleMode = (viewport: Viewport): Viewport =>
  initialViewport(viewport.mode === "fit" ? "fill" : "fit");

export const isReset = (viewport: Viewport) =>
  viewport.zoom === MIN_ZOOM &&
  viewport.offset.x === 0 &&
  viewport.offset.y === 0;
