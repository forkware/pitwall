// A multiline field with the "field.actions" slot in its corner, so plugins can add to every such field
// (a microphone, say) without knowing the forms it is in.
import { forwardRef, useCallback, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { cx } from "./kit/index.tsx";

/** A multiline field, as plugins see it. */
export interface FieldHandle {
  /** The textarea; null before it is mounted. */
  element(): HTMLTextAreaElement | null;
  /** Types text at the cursor (replacing the selection) as if the user typed it, with a space before when needed. */
  insert(text: string): void;
  focus(): void;
}

// slots.tsx hands in its Slot: importing it here would load the plugins before #sdk/ui, which they import.
let renderActions: (field: FieldHandle) => ReactNode = () => null;
export function setFieldActions(render: (field: FieldHandle) => ReactNode): void {
  renderActions = render;
}

export const TextArea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function TextArea(
  { className, ...props },
  ref,
) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      own.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const field = useMemo<FieldHandle>(
    () => ({
      element: () => own.current,
      insert: (text) => own.current && insertText(own.current, text),
      focus: () => own.current?.focus(),
    }),
    [],
  );
  return (
    <div className="relative">
      <textarea ref={setRef} className={cx(className, "pr-9")} {...props} />
      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {renderActions(field)}
      </div>
    </div>
  );
});

/** Inserts text at the cursor so that React's onChange and the undo history see it. */
export function insertText(el: HTMLTextAreaElement, text: string): void {
  if (!text) return;
  el.focus();
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const chunk = before && !/\s$/.test(before) && !/^\s/.test(text) ? ` ${text}` : text;
  // execCommand keeps undo working; where it is gone, setRangeText and an input event do the same for React.
  if (typeof document.execCommand === "function" && document.execCommand("insertText", false, chunk)) return;
  el.setRangeText(chunk, start, end, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
