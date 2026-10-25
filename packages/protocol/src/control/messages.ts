import { exact, id, record } from "../stream/guards.ts";
import {
  MAX_CONTROL_BYTES,
  MAX_GESTURE_MS,
  MAX_SWIPE_POINTS,
  MAX_TEXT_UNITS,
  MIN_GESTURE_MS,
} from "./constants.ts";

/** Real size of the captured display in its current rotation, in physical pixels. */
export interface DisplayGeometry {
  width: number;
  height: number;
  /** Surface rotation, 0 to 3 quarter turns. */
  rotation: 0 | 1 | 2 | 3;
}

export type ControlOffReason =
  | "unsupported"
  | "service-disabled"
  | "not-allowed"
  | "revoked"
  | "geometry-unknown";

export type ControlStatus = {
  v: 1;
  sessionId: string;
  type: "status";
  epoch: number;
} & (
  | { state: "on"; geometry: DisplayGeometry }
  | { state: "off"; reason: ControlOffReason }
);

/**
 * What the phone can do beyond taps and swipes, for one epoch. Sent after every status. A desktop that does
 * not know this message drops it, and a phone that never sends it is treated as tap and swipe only.
 */
export interface ControlCaps {
  v: 1;
  sessionId: string;
  type: "caps";
  epoch: number;
  /** Android 13+ with the accessibility input method available: `text` and `key` commands are understood. */
  text: boolean;
}

/** `nofield`: no editable field on the phone has input focus, so nothing was typed. */
export type CommandRejection = "stale" | "off" | "invalid" | "busy" | "nofield";

export type CommandResult = {
  v: 1;
  sessionId: string;
  type: "result";
  epoch: number;
  seq: number;
} & (
  | { status: "done" | "cancelled" | "failed" }
  | { status: "rejected"; reason: CommandRejection }
);

/** A point in the captured display, 0 to 1 on both axes. (0, 0) is the top left. */
export type NormalizedPoint = readonly [x: number, y: number];

export type InputCommand = {
  v: 1;
  sessionId: string;
  epoch: number;
  seq: number;
} & (
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; durationMs: number; points: NormalizedPoint[] }
  /** Committed to the focused field. See `validTypedText`. */
  | { type: "text"; text: string }
  /** Enter uses the field's own action: send, search, next, or a new line. */
  | { type: "key"; key: TypedKey }
  | { type: "nav"; action: NavAction }
);

export type TypedKey = "backspace" | "delete" | "enter";
const KEYS: readonly string[] = ["backspace", "delete", "enter"];

/** Android system navigation, performed by the phone as a global action rather than a touch. */
export type NavAction = "back" | "home" | "recents";
export const NAV_ACTIONS: readonly NavAction[] = ["back", "home", "recents"];

/**
 * Phone to desktop, beside `status`: the navigation actions the phone can perform right now. Its own
 * message type so desktops that predate it drop it, and a desktop never sends `nav` to a phone that did
 * not advertise it. Availability is not a grant: `nav` is still gated like a tap.
 */
export interface NavCapabilities {
  v: 1;
  sessionId: string;
  type: "nav-caps";
  epoch: number;
  actions: NavAction[];
}

const OFF_REASONS: readonly string[] = [
  "unsupported",
  "service-disabled",
  "not-allowed",
  "revoked",
  "geometry-unknown",
];
const REJECTIONS: readonly string[] = [
  "stale",
  "off",
  "invalid",
  "busy",
  "nofield",
];
const MAX_COUNTER = 2_147_483_647;
const MAX_DISPLAY_PIXELS = 16_384;

const counter = (value: unknown, min: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= MAX_COUNTER;
const unit = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

function decode(text: string, sessionId: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > MAX_CONTROL_BYTES)
    throw new Error("Control message is too large.");
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    value.v !== 1 ||
    value.sessionId !== sessionId ||
    !id(value.sessionId)
  )
    throw new Error("Invalid control session.");
  return value;
}

const BASE = ["v", "sessionId", "type", "epoch"];

export function parseControlStatus(
  text: string,
  sessionId: string,
): ControlStatus {
  const value = decode(text, sessionId);
  const valid =
    value.type === "status" &&
    counter(value.epoch, 0) &&
    (value.state === "on"
      ? exact(value, [...BASE, "state", "geometry"]) &&
        validGeometry(value.geometry)
      : value.state === "off"
        ? exact(value, [...BASE, "state", "reason"]) &&
          typeof value.reason === "string" &&
          OFF_REASONS.includes(value.reason)
        : false);
  if (!valid) throw new Error("Invalid control status.");
  return value as unknown as ControlStatus;
}

function validGeometry(value: unknown): value is DisplayGeometry {
  return (
    record(value) &&
    exact(value, ["width", "height", "rotation"]) &&
    counter(value.width, 1) &&
    counter(value.height, 1) &&
    Number(value.width) <= MAX_DISPLAY_PIXELS &&
    Number(value.height) <= MAX_DISPLAY_PIXELS &&
    Number.isInteger(value.rotation) &&
    Number(value.rotation) >= 0 &&
    Number(value.rotation) <= 3
  );
}

export function parseNavCapabilities(
  text: string,
  sessionId: string,
): NavCapabilities {
  const value = decode(text, sessionId);
  const actions = value.actions;
  const valid =
    value.type === "nav-caps" &&
    exact(value, [...BASE, "actions"]) &&
    counter(value.epoch, 0) &&
    Array.isArray(actions) &&
    actions.length <= NAV_ACTIONS.length &&
    actions.every(
      (action: unknown, index) =>
        NAV_ACTIONS.includes(action as NavAction) &&
        actions.indexOf(action) === index,
    );
  if (!valid) throw new Error("Invalid navigation capabilities.");
  return value as unknown as NavCapabilities;
}

export function parseControlCaps(text: string, sessionId: string): ControlCaps {
  const value = decode(text, sessionId);
  const valid =
    value.type === "caps" &&
    exact(value, [...BASE, "text"]) &&
    counter(value.epoch, 0) &&
    typeof value.text === "boolean";
  if (!valid) throw new Error("Invalid control capabilities.");
  return value as unknown as ControlCaps;
}

/** Typed text uses `\n` for new lines. Pasted Windows and old Mac line endings become `\n`. */
export const normalizeTypedText = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

/**
 * Text a `text` command may carry: 1 to `MAX_TEXT_UNITS` UTF-16 units, whole surrogate pairs only, and no
 * control characters other than new line and tab. Mirrored by `ControlWire.validText` on the phone.
 */
export function validTypedText(text: unknown): text is string {
  if (
    typeof text !== "string" ||
    text.length < 1 ||
    text.length > MAX_TEXT_UNITS
  )
    return false;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else if (
      (unit < 0x20 && unit !== 0x0a && unit !== 0x09) ||
      (unit >= 0x7f && unit <= 0x9f)
    )
      return false;
  }
  return true;
}

export function parseCommandResult(
  text: string,
  sessionId: string,
): CommandResult {
  const value = decode(text, sessionId);
  const base = [...BASE, "seq", "status"];
  const valid =
    value.type === "result" &&
    counter(value.epoch, 0) &&
    counter(value.seq, 1) &&
    (value.status === "rejected"
      ? exact(value, [...base, "reason"]) &&
        typeof value.reason === "string" &&
        REJECTIONS.includes(value.reason)
      : (value.status === "done" ||
          value.status === "cancelled" ||
          value.status === "failed") &&
        exact(value, base));
  if (!valid) throw new Error("Invalid command result.");
  return value as unknown as CommandResult;
}

export function parseInputCommand(
  text: string,
  sessionId: string,
): InputCommand {
  const value = decode(text, sessionId);
  const base = [...BASE, "seq"];
  const valid =
    counter(value.epoch, 0) &&
    counter(value.seq, 1) &&
    (value.type === "tap"
      ? exact(value, [...base, "x", "y"]) && unit(value.x) && unit(value.y)
      : value.type === "swipe"
        ? exact(value, [...base, "durationMs", "points"]) &&
          counter(value.durationMs, MIN_GESTURE_MS) &&
          value.durationMs <= MAX_GESTURE_MS &&
          Array.isArray(value.points) &&
          value.points.length >= 2 &&
          value.points.length <= MAX_SWIPE_POINTS &&
          value.points.every(
            (point: unknown) =>
              Array.isArray(point) &&
              point.length === 2 &&
              unit(point[0]) &&
              unit(point[1]),
          )
        : value.type === "text"
          ? exact(value, [...base, "text"]) && validTypedText(value.text)
          : value.type === "key"
            ? exact(value, [...base, "key"]) &&
              typeof value.key === "string" &&
              KEYS.includes(value.key)
            : value.type === "nav"
              ? exact(value, [...base, "action"]) &&
                NAV_ACTIONS.includes(value.action as NavAction)
              : false);
  if (!valid) throw new Error("Invalid input command.");
  return value as unknown as InputCommand;
}

/** Throws when the command would be refused by the phone for its size. */
export function encodeInputCommand(command: InputCommand): string {
  const text = JSON.stringify(command);
  if (new TextEncoder().encode(text).length > MAX_CONTROL_BYTES)
    throw new Error("Control message is too large.");
  return text;
}
