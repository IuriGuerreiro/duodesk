import type { NormalizedPoint } from "@duodesk/protocol";

/*
 * Mouse wheel and trackpad scrolling, sent as ordinary swipes. Android has no scroll command for an
 * accessibility service, so a wheel turn becomes a short finger drag that starts under the pointer.
 * The numbers below are tuning guesses, not measured defaults.
 */

/** `WheelEvent.DOM_DELTA_*`, spelled out so this file also runs outside a browser. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
/** CSS pixels per wheel "line", roughly what browsers scroll per notch. */
export const LINE_PX = 16;
/** Longest finger travel for one swipe, as a share of the screen along that axis. */
export const MAX_TRAVEL = 0.15;
/** A pointer this close to an edge (share of the screen) may hit system edge gestures, so it is ignored. */
export const EDGE_BAND = 0.03;
export const MIN_SCROLL_MS = 200;
export const MAX_SCROLL_MS = 400;
/** Scroll waiting for the phone is dropped if the wheel has been still this long. */
export const STALE_MS = 250;
/** Moving the pointer this far (share of the screen) starts a new scroll instead of adding to the old one. */
const MOVE_RESET = 0.02;

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Wheel movement in CSS pixels of the picture, or undefined for input that is not a scroll.
 * Ctrl+wheel is how trackpads report a pinch, so it is ignored.
 */
export function wheelPixels(
  event: WheelInput,
  picture: Size,
): { dx: number; dy: number } | undefined {
  if (event.ctrlKey) return undefined;
  const scale = (size: number) =>
    event.deltaMode === DOM_DELTA_LINE
      ? LINE_PX
      : event.deltaMode === DOM_DELTA_PAGE
        ? size
        : 1;
  let dx = event.deltaX * scale(picture.width);
  let dy = event.deltaY * scale(picture.height);
  // A plain mouse has no horizontal wheel; Shift turns it sideways.
  if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0))
    return undefined;
  return { dx, dy };
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * One swipe for a scroll of (dx, dy) picture pixels starting at `start`. Scrolling down moves the finger
 * up, like a touch screen. Travel is capped and the end is kept off the edges; the start never moves, so
 * the swipe stays in the list under the pointer. Undefined when the pointer is in the edge band.
 */
export function wheelSwipe(
  start: NormalizedPoint,
  dx: number,
  dy: number,
  picture: Size,
): { points: NormalizedPoint[]; durationMs: number } | undefined {
  const [x, y] = start;
  if (
    x < EDGE_BAND ||
    x > 1 - EDGE_BAND ||
    y < EDGE_BAND ||
    y > 1 - EDGE_BAND ||
    picture.width <= 0 ||
    picture.height <= 0
  )
    return undefined;
  const moveX = clamp(-dx / picture.width, -MAX_TRAVEL, MAX_TRAVEL);
  const moveY = clamp(-dy / picture.height, -MAX_TRAVEL, MAX_TRAVEL);
  const end: NormalizedPoint = [
    clamp(x + moveX, EDGE_BAND, 1 - EDGE_BAND),
    clamp(y + moveY, EDGE_BAND, 1 - EDGE_BAND),
  ];
  const travel = Math.max(Math.abs(end[0] - x), Math.abs(end[1] - y));
  // Too short to scroll anything, and Android could read it as a tap.
  if (travel < 0.005) return undefined;
  const durationMs = Math.round(
    MIN_SCROLL_MS + (MAX_SCROLL_MS - MIN_SCROLL_MS) * (travel / MAX_TRAVEL),
  );
  return { points: [start, end], durationMs };
}

/** What the scroller needs from `ControlLink`. */
export interface WheelLink {
  currentEpoch(): number;
  getView(): { busy: boolean; epoch: number };
  subscribe(listener: () => void): () => void;
  swipe(
    points: NormalizedPoint[],
    durationMs: number,
    epoch: number,
    video: Size,
  ): boolean;
}

interface Pending {
  start: NormalizedPoint;
  dx: number;
  dy: number;
  epoch: number;
  picture: Size;
  video: Size;
  lastAt: number;
}

/**
 * Collects wheel movement while the phone is busy and sends it as one swipe when it is free. At most one
 * swipe's worth is kept: a fast wheel loses the excess instead of building a backlog.
 */
export class WheelScroller {
  private pending?: Pending;
  private unsubscribe: () => void;
  private epoch: number;
  private link: WheelLink;
  private now: () => number;

  constructor(link: WheelLink, now: () => number = () => performance.now()) {
    this.link = link;
    this.now = now;
    this.epoch = link.getView().epoch;
    this.unsubscribe = link.subscribe(() => {
      const view = link.getView();
      if (view.epoch !== this.epoch) {
        this.epoch = view.epoch;
        this.clear();
      } else if (!view.busy) this.flush();
    });
  }

  get waiting() {
    return this.pending !== undefined;
  }

  wheel(event: WheelInput, start: NormalizedPoint, picture: Size, video: Size) {
    const delta = wheelPixels(event, picture);
    if (!delta) return;
    const at = this.now();
    const epoch = this.link.currentEpoch();
    let pending = this.pending;
    if (
      !pending ||
      pending.epoch !== epoch ||
      at - pending.lastAt > STALE_MS ||
      Math.abs(pending.start[0] - start[0]) > MOVE_RESET ||
      Math.abs(pending.start[1] - start[1]) > MOVE_RESET ||
      pending.dx * delta.dx < 0 ||
      pending.dy * delta.dy < 0
    )
      pending = { start, dx: 0, dy: 0, epoch, picture, video, lastAt: at };
    const capX = MAX_TRAVEL * picture.width;
    const capY = MAX_TRAVEL * picture.height;
    pending.dx = clamp(pending.dx + delta.dx, -capX, capX);
    pending.dy = clamp(pending.dy + delta.dy, -capY, capY);
    pending.lastAt = at;
    this.pending = pending;
    this.flush();
  }

  /** Sends what has collected if the phone is free. Anything the link refuses is dropped, not retried. */
  flush() {
    const pending = this.pending;
    if (!pending || this.link.getView().busy) return;
    this.pending = undefined;
    if (this.now() - pending.lastAt > STALE_MS) return;
    if (pending.epoch !== this.link.currentEpoch()) return;
    const swipe = wheelSwipe(
      pending.start,
      pending.dx,
      pending.dy,
      pending.picture,
    );
    if (!swipe) return;
    this.link.swipe(
      swipe.points,
      swipe.durationMs,
      pending.epoch,
      pending.video,
    );
  }

  clear() {
    this.pending = undefined;
  }

  close() {
    this.clear();
    this.unsubscribe();
  }
}
