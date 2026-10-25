import {
  MAX_TEXT_UNITS,
  normalizeTypedText,
  validTypedText,
} from "@duodesk/protocol";
import type { TypingOutcome } from "./control-link";

/** Turns the composer draft into a `text` command body, or explains why it cannot be sent. */
export function prepareText(
  draft: string,
): { text: string } | { error: string } | undefined {
  const text = normalizeTypedText(draft);
  if (!text) return undefined;
  if (text.length > MAX_TEXT_UNITS)
    return {
      error: `Too long. Send up to ${MAX_TEXT_UNITS} characters at a time.`,
    };
  if (!validTypedText(text))
    return { error: "This text has characters the phone can't type." };
  return { text };
}

/**
 * The draft after the phone confirmed `sent`. Text typed while the command was in flight is kept. If the
 * sent part itself was edited, the whole draft stays so nothing is lost, and the caller says so.
 */
export function settleDraft(
  draft: string,
  sent: string,
): { draft: string; edited: boolean } {
  return draft.startsWith(sent)
    ? { draft: draft.slice(sent.length), edited: false }
    : { draft, edited: true };
}

/** Enter sends; Shift+Enter is a new line; Enter that confirms an IME composition is left to the IME. */
export function isSendKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing &&
    // Some IMEs report the confirming Enter only as key code 229.
    event.keyCode !== 229
  );
}

export const typingNotices: Record<TypingOutcome, string> = {
  done: "Sent to the phone.",
  nofield: "Nothing typed. Tap a text field on the phone first.",
  rejected: "The phone refused it. Nothing was typed.",
  failed: "Typing failed on the phone. Check the phone before sending again.",
  unconfirmed: "Not confirmed. Check the phone before sending again.",
};
