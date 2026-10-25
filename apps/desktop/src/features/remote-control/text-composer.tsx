import { useState, type KeyboardEvent } from "react";
import {
  CornerDownLeft,
  Delete,
  Keyboard,
  SendHorizontal,
  X,
} from "lucide-react";
import { MAX_TEXT_UNITS, type TypedKey } from "@duodesk/protocol";
import { Button } from "@/shared/ui/button";
import type { ControlLink } from "./control-link";
import { useControlView } from "./control-surface";
import { isSendKey, prepareText, settleDraft, typingNotices } from "./typing";

type InFlight = { seq: number } & (
  { kind: "text"; sent: string } | { kind: "key" }
);

/**
 * Types into the focused field on the phone. Text is sent only on an explicit Send, one command at a time,
 * and the draft stays until the phone confirms it. Nothing here is logged or stored.
 */
export function TextComposer({ link }: { link: ControlLink | undefined }) {
  const view = useControlView(link);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [inFlight, setInFlight] = useState<InFlight>();
  const [notice, setNotice] = useState("");

  // Settle the command in flight as soon as the phone's answer, or its absence, is known.
  if (inFlight && view.typing?.seq === inFlight.seq) {
    const outcome = view.typing.outcome;
    setInFlight(undefined);
    if (inFlight.kind === "text" && outcome === "done") {
      const next = settleDraft(draft, inFlight.sent);
      setDraft(next.draft);
      setNotice(
        next.edited
          ? "Sent. You edited the draft while sending, so all of it was kept."
          : typingNotices.done,
      );
    } else {
      setNotice(outcome === "done" ? "" : typingNotices[outcome]);
    }
  }

  const usable =
    !!link &&
    view.text &&
    (view.phase === "active" || view.phase === "syncing");
  // Kept on screen while it holds anything, so a lost capability never hides an unsent draft.
  if (!link || (!usable && !draft && !inFlight && !open)) return null;

  const ready = usable && !view.busy && !inFlight && !view.paused;

  const sendText = () => {
    if (!ready) return;
    const prepared = prepareText(draft);
    if (!prepared) return;
    if ("error" in prepared) return setNotice(prepared.error);
    const seq = link.typeText(prepared.text);
    if (seq === undefined)
      return setNotice("Couldn't send. Nothing was typed.");
    setInFlight({ seq, kind: "text", sent: draft });
    setNotice("Sending…");
  };

  const sendKey = (key: TypedKey) => {
    if (!ready) return;
    const seq = link.typeKey(key);
    if (seq === undefined)
      return setNotice("Couldn't send. Nothing was typed.");
    setInFlight({ seq, kind: "key" });
    setNotice("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (
      isSendKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: native.isComposing,
        keyCode: native.keyCode,
      })
    ) {
      event.preventDefault();
      sendText();
    } else if (event.key === "Escape" && !native.isComposing) {
      // Leaves the composer only; the draft stays.
      event.currentTarget.blur();
    }
  };

  if (!open)
    return (
      <div className="text-composer collapsed">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Keyboard /> Type on phone
        </Button>
      </div>
    );

  const length = draft.length;
  const status = !usable
    ? view.paused
      ? "Control is paused on this PC."
      : "Typing isn't available right now."
    : notice;

  return (
    <div className="text-composer" role="group" aria-label="Type on the phone">
      <textarea
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        spellCheck={false}
        autoComplete="off"
        placeholder="Tap a field on the phone, then type here. Enter sends, Shift+Enter adds a line."
        aria-label="Text to type on the phone"
      />
      <div className="text-composer-actions">
        <span
          className={
            length > MAX_TEXT_UNITS ? "composer-count over" : "composer-count"
          }
        >
          {length}/{MAX_TEXT_UNITS}
        </span>
        <span className="composer-status" role="status">
          {status}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => sendKey("backspace")}
          disabled={!ready}
          aria-label="Backspace on the phone"
          title="Backspace on the phone"
        >
          <Delete />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => sendKey("delete")}
          disabled={!ready}
          aria-label="Delete forward on the phone"
          title="Delete forward on the phone"
        >
          Del
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => sendKey("enter")}
          disabled={!ready}
          aria-label="Press Enter on the phone"
          title="Press Enter on the phone"
        >
          <CornerDownLeft />
        </Button>
        <Button size="sm" onClick={sendText} disabled={!ready || !draft}>
          <SendHorizontal /> Send
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(false)}
          aria-label="Hide typing"
          title="Hide typing"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
