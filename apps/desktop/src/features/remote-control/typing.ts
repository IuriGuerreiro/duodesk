import {
  MAX_TEXT_UNITS,
  normalizeTypedText,
  validTypedText,
  type TypedKey,
} from "@duodesk/protocol";
import type { TypingOutcome } from "./control-link";

export type TypingCommand =
  { kind: "text"; text: string } | { kind: "key"; key: TypedKey };

/**
 * Keystrokes waiting for the phone, in the order they were typed. The phone takes one command at a time,
 * so text typed while it is busy is merged and sent as one `text` command once it answers.
 */
export class TypingQueue {
  private items: TypingCommand[] = [];

  /**
   * Adds typed or pasted text. Returns false, and adds nothing, when the phone could not type it or it is
   * longer than one command.
   */
  pushText(raw: string): boolean {
    const text = normalizeTypedText(raw);
    if (!text) return true;
    if (!validTypedText(text)) return false;
    const last = this.items[this.items.length - 1];
    if (last?.kind === "text") last.text += text;
    else this.items.push({ kind: "text", text });
    return true;
  }

  pushKey(key: TypedKey) {
    this.items.push({ kind: "key", key });
  }

  /** Removes and returns the next command. Long text is split, never inside a surrogate pair. */
  take(): TypingCommand | undefined {
    const first = this.items[0];
    if (!first) return undefined;
    if (first.kind === "key" || first.text.length <= MAX_TEXT_UNITS) {
      this.items.shift();
      return first;
    }
    let end = MAX_TEXT_UNITS;
    const unit = first.text.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) end--;
    const text = first.text.slice(0, end);
    first.text = first.text.slice(end);
    return { kind: "text", text };
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}

/** The phone key a desktop key press maps to. Shortcuts (Ctrl, Alt, Meta) and IME confirmation map to none. */
export function keyFor(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): TypedKey | undefined {
  // Some IMEs report keys they consume only as key code 229.
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.ctrlKey || event.altKey || event.metaKey) return undefined;
  if (event.key === "Backspace") return "backspace";
  if (event.key === "Delete") return "delete";
  if (event.key === "Enter") return "enter";
  return undefined;
}

export const typingNotices: Record<Exclude<TypingOutcome, "done">, string> = {
  nofield: "Tap a text field on the phone first. Waiting keys were dropped.",
  rejected: "The phone refused a key. Waiting keys were dropped.",
  failed: "Typing failed on the phone. Waiting keys were dropped.",
  unconfirmed:
    "A key wasn't confirmed. Check the phone; waiting keys were dropped.",
};
