type RecoverableKeyboardEvent = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

const EDITABLE_SELECTOR =
  "input, textarea, [contenteditable='true'], [role='textbox'], .cm-editor";

export function shouldRecoverTerminalInputFocus(
  activeElement: Element | null,
  body: Element | null = null,
): boolean {
  if (!activeElement || activeElement === body) return true;
  if (activeElement.closest?.(".xterm")) return false;
  if (activeElement.closest?.(EDITABLE_SELECTOR)) return false;
  return true;
}

export function recoveredTerminalInput(
  event: RecoverableKeyboardEvent,
): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;

  if (event.key.length === 1) return event.key;
  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    default:
      return null;
  }
}
