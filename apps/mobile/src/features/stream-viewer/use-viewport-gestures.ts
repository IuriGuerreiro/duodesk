import { useEffect, useState } from "react";
import {
  PanResponder,
  type GestureResponderEvent,
  type PanResponderInstance,
} from "react-native";
import {
  isReset,
  pan,
  pinch,
  type Point,
  type Size,
  type Viewport,
} from "./viewport";

const DOUBLE_TAP_MS = 280;
const TAP_SLOP = 8;

type Touches = GestureResponderEvent["nativeEvent"]["touches"];

const point = (t: Touches, i: number): Point => ({
  x: t[i]?.pageX ?? 0,
  y: t[i]?.pageY ?? 0,
});
const center = (t: Touches): Point => {
  const [a, b] = [point(t, 0), point(t, 1)];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};
const distance = (t: Touches) => {
  const [a, b] = [point(t, 0), point(t, 1)];
  return Math.hypot(a.x - b.x, a.y - b.y);
};

/**
 * Pinch, pan, tap and double-tap on the viewer. These only move the local picture;
 * nothing here is sent to the desktop.
 */
export function useViewportGestures(
  options: GestureOptions,
): PanResponderInstance {
  const [gestures] = useState(() => {
    let current = options;
    return {
      update: (next: GestureOptions) => {
        current = next;
      },
      responder: createViewportResponder(() => current),
    };
  });
  useEffect(() => gestures.update(options));
  return gestures.responder;
}

interface GestureOptions {
  viewport: Viewport;
  container: Size;
  video: Size;
  onChange(viewport: Viewport): void;
  onTap(): void;
  onReset(): void;
}

// Gesture state lives in this closure, outside React render.
function createViewportResponder(
  read: () => GestureOptions,
): PanResponderInstance {
  let start: Viewport = read().viewport;
  let pinchStart: { distance: number; center: Point } | null = null;
  let panOrigin: Point | null = null;
  let moved = false;
  let lastTap = 0;

  const begin = (event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches;
    start = read().viewport;
    if (touches.length >= 2) {
      pinchStart = { distance: distance(touches), center: center(touches) };
      panOrigin = null;
      moved = true;
    } else if (touches.length === 1) {
      pinchStart = null;
      panOrigin = point(touches, 0);
    }
  };

  return PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      moved = false;
      begin(event);
    },
    onPanResponderMove: (event) => {
      const touches = event.nativeEvent.touches;
      const { container, video, onChange } = read();
      // Finger count changed mid-gesture: restart from the current picture.
      if (touches.length >= 2 !== (pinchStart !== null)) begin(event);
      if (touches.length >= 2 && pinchStart) {
        onChange(
          pinch(start, container, video, {
            startDistance: pinchStart.distance,
            distance: distance(touches),
            startCenter: pinchStart.center,
            center: center(touches),
          }),
        );
      } else if (touches.length === 1 && panOrigin) {
        const now = point(touches, 0);
        const delta = { x: now.x - panOrigin.x, y: now.y - panOrigin.y };
        if (Math.hypot(delta.x, delta.y) > TAP_SLOP) moved = true;
        if (moved) onChange(pan(start, container, video, delta));
      }
    },
    onPanResponderRelease: () => {
      pinchStart = null;
      panOrigin = null;
      if (moved) return;
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        if (!isReset(read().viewport)) read().onReset();
        return;
      }
      lastTap = now;
      read().onTap();
    },
    onPanResponderTerminate: () => {
      pinchStart = null;
      panOrigin = null;
    },
  });
}
