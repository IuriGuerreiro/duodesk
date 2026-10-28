import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Keyboard, KeyboardOff } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type { ControlLink } from "./control-link";
import { useControlView } from "./control-surface";
import { TypingQueue, keyFor, typingNotices } from "./typing";

/**
 * Sends keystrokes to the focused field on the phone as they are typed. On by default. A hidden field
 * catches the keys, so desktop input methods (accents, CJK) deliver finished characters. Keys typed while
 * the phone is answering wait in a queue; any failure drops the queue rather than retrying. Nothing here is
 * logged or stored.
 */
export function PhoneKeyboard({ link }: { link: ControlLink | undefined }) {
  const view = useControlView(link);
  const [on, setOn] = useState(true);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState("");
  const queue = useRef(new TypingQueue());
  const sent = useRef<number | undefined>(undefined);
  const composing = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);

  const usable =
    !!link &&
    view.text &&
    (view.phase === "active" || view.phase === "syncing");

  /** Sends the next queued command once the phone is free. */
  const pump = useCallback(() => {
    if (!link || sent.current !== undefined || link.getView().busy) return;
    if (link.typeBlocker()) return;
    const next = queue.current.take();
    if (!next) return;
    const seq =
      next.kind === "text" ? link.typeText(next.text) : link.typeKey(next.key);
    if (seq === undefined) {
      queue.current.clear();
      setNotice("Couldn't send. Waiting keys were dropped.");
      return;
    }
    sent.current = seq;
  }, [link]);

  // Settle the command in flight, then send whatever was typed meanwhile.
  useEffect(() => {
    if (!link) return;
    const unsubscribe = link.subscribe(() => {
      const current = link.getView();
      const result = current.typing;
      if (sent.current !== undefined && result?.seq === sent.current) {
        sent.current = undefined;
        if (result.outcome === "done") setNotice("");
        else {
          queue.current.clear();
          setNotice(typingNotices[result.outcome]);
        }
      }
      if (
        !current.text ||
        (current.phase !== "active" && current.phase !== "syncing")
      ) {
        queue.current.clear();
        sent.current = undefined;
      }
      pump();
    });
    return () => {
      unsubscribe();
    };
  }, [link, pump]);

  // While on, the phone picture and a page with nothing focused both send keys to the phone.
  useEffect(() => {
    if (!on || !usable) return;
    const take = () => field.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.(".control-surface"))
        take();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target === document.body) take();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    take();
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [on, usable]);

  if (!link || (!usable && !notice)) return null;

  const pushText = (text: string) => {
    if (!text) return;
    if (!queue.current.pushText(text))
      return setNotice("The phone can't type that, or it's too long.");
    setNotice("");
    pump();
  };

  const takeField = () => {
    const element = field.current;
    if (!element) return;
    const text = element.value;
    element.value = "";
    pushText(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (event.key === "Escape" && !native.isComposing) {
      event.preventDefault();
      setOn(false);
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !native.isComposing) {
      event.preventDefault();
      return pushText("\t");
    }
    const key = keyFor({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      isComposing: native.isComposing,
      keyCode: native.keyCode,
    });
    if (!key) return;
    event.preventDefault();
    // Text typed just before this key goes first.
    takeField();
    queue.current.pushKey(key);
    setNotice("");
    pump();
  };

  const status = !usable
    ? notice
    : !on
      ? "Keyboard off."
      : notice ||
        (focused
          ? "Typing goes to the phone. Esc stops."
          : "Click the phone picture to type on it.");

  return (
    <div
      className="phone-keyboard"
      role="group"
      aria-label="Keyboard for the phone"
    >
      {usable && (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={on}
          onClick={() => {
            setOn(!on);
            setNotice("");
          }}
        >
          {on ? <Keyboard /> : <KeyboardOff />}
          {on ? "Keyboard on" : "Keyboard off"}
        </Button>
      )}
      <span className="phone-keyboard-status" role="status">
        {status}
      </span>
      {usable && on && (
        <textarea
          ref={field}
          className="phone-keyboard-field"
          onKeyDown={onKeyDown}
          onInput={() => {
            if (!composing.current) takeField();
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            takeField();
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Type on the phone"
        />
      )}
    </div>
  );
}
