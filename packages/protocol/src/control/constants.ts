/** Remote control rides on two negotiated data channels of the existing WebRTC peer connection. */
export const CONTROL_VERSION = 1;
/** Reliable and ordered. Phone to desktop only: control status and command results. */
export const CONTROL_CHANNEL = { label: "duodesk-control", id: 1 } as const;
/**
 * Ordered but short-lived. Desktop to phone only: taps and swipes. A command that cannot be
 * delivered within `INPUT_PACKET_LIFETIME_MS` is dropped, so a network stall never replays old input.
 */
export const INPUT_CHANNEL = { label: "duodesk-input", id: 2 } as const;
export const INPUT_PACKET_LIFETIME_MS = 500;

export const MAX_CONTROL_BYTES = 2048;
export const MAX_SWIPE_POINTS = 32;
export const MIN_GESTURE_MS = 50;
export const MAX_GESTURE_MS = 2000;
/** The phone repeats its status this often, so a channel that opens late still learns the state. */
export const STATUS_HEARTBEAT_MS = 1000;
/** The desktop treats control as off when the phone has been silent this long. */
export const STATUS_TIMEOUT_MS = 4000;
/** The desktop forgets an unanswered command after this long. Must exceed `MAX_GESTURE_MS`. */
export const RESULT_TIMEOUT_MS = 3500;
/** Most UTF-16 code units one `text` command may carry. Keeps every command far below `MAX_CONTROL_BYTES`. */
export const MAX_TEXT_UNITS = 500;
