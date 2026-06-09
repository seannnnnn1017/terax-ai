export type TerminalFocusOwner = "none" | "terminal" | "other";

type FocusableTerminal = {
  focus: () => void;
};

type TerminalFocusDocument = {
  readonly activeElement: Element | null;
};

export function classifyTerminalFocusOwner(
  activeElement: Element | null,
  body: Element | null,
  documentElement: Element | null,
): TerminalFocusOwner {
  if (
    activeElement === null ||
    activeElement === body ||
    activeElement === documentElement
  ) {
    return "none";
  }
  return activeElement.closest?.(".xterm") ? "terminal" : "other";
}

export function restoreTerminalFocus(
  terminal: FocusableTerminal | null,
  owner: TerminalFocusOwner,
): boolean {
  if (!terminal || owner === "other") return false;
  terminal.focus();
  return true;
}

export function focusTerminalInput(
  terminal: FocusableTerminal | null,
  host: HTMLElement | null,
  doc: TerminalFocusDocument = document,
): boolean {
  if (!terminal || !host) return false;
  const helper = host.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  terminal.focus();
  if (helper && doc.activeElement === helper) return true;
  if (!helper && host.contains(doc.activeElement)) return true;

  if (!helper) return false;
  try {
    helper.focus({ preventScroll: true });
  } catch {
    helper.focus();
  }
  return doc.activeElement === helper || host.contains(doc.activeElement);
}
