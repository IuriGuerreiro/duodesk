import {
  MAX_GESTURE_MS,
  MAX_SWIPE_POINTS,
  MIN_GESTURE_MS,
  type NormalizedPoint,
} from "@duodesk/protocol";

/** Pointer travel (CSS pixels) that still counts as a click. */
export const TAP_SLOP_PX = 8;
/** A press held longer than this without moving is not a tap, and is ignored rather than guessed at. */
export const TAP_MAX_MS = 500;
/** Samples closer than this to the previous one add nothing to the path. */
const MIN_STEP_PX = 2;
/** Fewer than the protocol allows: the path stays short on the wire. */
const MAX_PATH_POINTS = 24;

export type Gesture =
  | { kind: "tap"; point: NormalizedPoint }
  | { kind: "swipe"; points: NormalizedPoint[]; durationMs: number }
  | { kind: "ignored" };

interface Sample {
  point: NormalizedPoint;
  x: number;
  y: number;
}

/** Keeps the first and last points and spreads the rest evenly. */
export function simplify<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from(
    { length: limit },
    (_, i) => items[Math.round((i * (items.length - 1)) / (limit - 1))]!,
  );
}

/**
 * Turns one press, drag and release into a single finished gesture. Nothing is sent while the button is
 * down: Android needs the whole path before it can perform a swipe.
 */
export class GestureRecorder {
  private samples: Sample[] = [];
  private startedAt = 0;

  get active() {
    return this.samples.length > 0;
  }

  begin(point: NormalizedPoint, x: number, y: number, now: number) {
    this.samples = [{ point, x, y }];
    this.startedAt = now;
  }

  move(point: NormalizedPoint, x: number, y: number) {
    const last = this.samples[this.samples.length - 1];
    if (!last) return;
    if (Math.hypot(x - last.x, y - last.y) < MIN_STEP_PX) return;
    this.samples.push({ point, x, y });
  }

  cancel() {
    this.samples = [];
  }

  end(point: NormalizedPoint, x: number, y: number, now: number): Gesture {
    const first = this.samples[0];
    if (!first) return { kind: "ignored" };
    this.move(point, x, y);
    const samples = this.samples;
    this.samples = [];
    const elapsed = Math.max(0, now - this.startedAt);
    const travel = Math.max(
      ...samples.map((s) => Math.hypot(s.x - first.x, s.y - first.y)),
    );
    if (travel <= TAP_SLOP_PX) {
      return elapsed <= TAP_MAX_MS
        ? { kind: "tap", point: first.point }
        : { kind: "ignored" };
    }
    const path = simplify(
      samples.map((s) => s.point),
      Math.min(MAX_PATH_POINTS, MAX_SWIPE_POINTS),
    );
    return {
      kind: "swipe",
      points: path,
      durationMs: Math.round(
        Math.min(MAX_GESTURE_MS, Math.max(MIN_GESTURE_MS, elapsed)),
      ),
    };
  }
}
