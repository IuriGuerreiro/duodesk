/**
 * Sender-side video settings. The user picks a bounding box (long side × short side) and a frame-rate cap.
 * The box follows the capture's orientation, so one choice fits portrait phones and landscape monitors alike,
 * and the picture is scaled down to fit it without changing its aspect ratio. Nothing is ever scaled up.
 */
export interface StreamSettings {
  /** Upper bound for the longer edge of the encoded picture, in pixels. */
  maxLongSide: number;
  /** Upper bound for the shorter edge of the encoded picture, in pixels. */
  maxShortSide: number;
  /** Upper bound for the encoded frame rate. Screen capture only sends frames when the screen changes. */
  frameRate: number;
}

/**
 * Bounds every sender accepts. 60 fps is the most both screen capture paths deliver; 3840 × 2160 is the
 * largest picture H.264 level 5.1 encoders accept. Each platform may narrow these further, see the senders.
 */
export const STREAM_LIMITS = {
  minShortSide: 240,
  maxShortSide: 2160,
  minLongSide: 320,
  maxLongSide: 3840,
  minFrameRate: 5,
  maxFrameRate: 60,
} as const;

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  maxLongSide: 1920,
  maxShortSide: 1080,
  frameRate: 60,
};

export type SettingsResult =
  | { ok: true; settings: StreamSettings }
  | { ok: false; error: string };

const whole = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

/** Checks user-entered settings. Errors name the field and the accepted range. */
export function validateStreamSettings(input: {
  maxLongSide: unknown;
  maxShortSide: unknown;
  frameRate: unknown;
}): SettingsResult {
  const L = STREAM_LIMITS;
  const long = whole(input.maxLongSide);
  const short = whole(input.maxShortSide);
  const rate = whole(input.frameRate);
  if (long === undefined || long < L.minLongSide || long > L.maxLongSide)
    return { ok: false, error: `Width must be a whole number from ${L.minLongSide} to ${L.maxLongSide} pixels.` };
  if (short === undefined || short < L.minShortSide || short > L.maxShortSide)
    return { ok: false, error: `Height must be a whole number from ${L.minShortSide} to ${L.maxShortSide} pixels.` };
  if (short > long)
    return { ok: false, error: "Height cannot be larger than width. Enter the long side as the width; portrait screens are rotated to match." };
  if (rate === undefined || rate < L.minFrameRate || rate > L.maxFrameRate)
    return { ok: false, error: `Frame rate must be a whole number from ${L.minFrameRate} to ${L.maxFrameRate} fps.` };
  return { ok: true, settings: { maxLongSide: long, maxShortSide: short, frameRate: rate } };
}

/** Parses text fields, such as form inputs, then validates them. */
export function parseStreamSettings(input: {
  maxLongSide: string;
  maxShortSide: string;
  frameRate: string;
}): SettingsResult {
  const number = (text: string) => (/^\s*\d+\s*$/.test(text) ? Number(text) : NaN);
  return validateStreamSettings({
    maxLongSide: number(input.maxLongSide),
    maxShortSide: number(input.maxShortSide),
    frameRate: number(input.frameRate),
  });
}

/**
 * The largest even-sized picture that fits the settings' box, oriented like the source, with the source's aspect
 * ratio. Never larger than the source. Mirrors `computeCaptureDimensions` in the Android sender.
 */
export function fitCapture(
  sourceWidth: number,
  sourceHeight: number,
  settings: Pick<StreamSettings, "maxLongSide" | "maxShortSide">,
): { width: number; height: number } {
  if (!(sourceWidth > 0 && sourceHeight > 0))
    throw new Error("The captured screen has no size.");
  const portrait = sourceHeight > sourceWidth;
  const boxWidth = portrait ? settings.maxShortSide : settings.maxLongSide;
  const boxHeight = portrait ? settings.maxLongSide : settings.maxShortSide;
  const scale = Math.min(1, boxWidth / sourceWidth, boxHeight / sourceHeight);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return {
    width: even(sourceWidth * scale),
    height: even(sourceHeight * scale),
  };
}
