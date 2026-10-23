import type { DisplayGeometry, NormalizedPoint } from "./messages.ts";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where an `object-fit: contain` video draws its picture inside its element. Everything outside
 * this rectangle is letterbox margin and must never produce input.
 */
export function containedContent(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
): Rect | undefined {
  if (
    ![elementWidth, elementHeight, videoWidth, videoHeight].every(
      (n) => n > 0 && Number.isFinite(n),
    )
  )
    return undefined;
  const scale = Math.min(
    elementWidth / videoWidth,
    elementHeight / videoHeight,
  );
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

/** Largest aspect ratio disagreement tolerated between the video and the phone's display. */
export const ASPECT_TOLERANCE = 0.02;

/**
 * The decoded picture must have the shape of the display the phone reported. During rotation the
 * geometry and the frames arrive separately, and disagreement means the mapping is uncertain.
 */
export function videoMatchesDisplay(
  geometry: DisplayGeometry,
  videoWidth: number,
  videoHeight: number,
  tolerance = ASPECT_TOLERANCE,
): boolean {
  if (!(videoWidth > 0 && videoHeight > 0)) return false;
  const shown = videoWidth / videoHeight;
  const real = geometry.width / geometry.height;
  return Math.abs(shown - real) / real <= tolerance;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Converts a pointer position to the display's 0 to 1 space. Positions off the picture clamp to its edge. */
export function toNormalized(
  clientX: number,
  clientY: number,
  content: Rect,
  clamp = true,
): NormalizedPoint | undefined {
  if (!(content.width > 0 && content.height > 0)) return undefined;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return undefined;
  return [clamp01(x), clamp01(y)];
}

/** Display pixel for a normalized coordinate. Mirrors the phone: the last pixel is `size - 1`. */
export const toPixel = (value: number, size: number): number =>
  Math.min(size - 1, Math.max(0, Math.round(value * (size - 1))));
