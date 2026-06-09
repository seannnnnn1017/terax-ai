import { describe, expect, it } from "vitest";
import {
  recoveredTerminalInput,
  shouldRecoverTerminalInputFocus,
} from "./terminalInputRecovery";

function el(matches: (selector: string) => boolean): Element {
  return {
    closest: (selector: string) => (matches(selector) ? {} : null),
  } as Element;
}

describe("terminal input recovery", () => {
  it("recovers printable input when focus is on non-editable chrome", () => {
    const active = el((selector) => selector === "button");

    expect(shouldRecoverTerminalInputFocus(active)).toBe(true);
    expect(recoveredTerminalInput({ key: "a" })).toBe("a");
    expect(recoveredTerminalInput({ key: "A" })).toBe("A");
  });

  it("does not recover when focus is already in terminal or editable controls", () => {
    expect(
      shouldRecoverTerminalInputFocus(
        el((selector) => selector === ".xterm"),
      ),
    ).toBe(false);
    expect(
      shouldRecoverTerminalInputFocus(
        el((selector) => selector === "input, textarea, [contenteditable='true'], [role='textbox'], .cm-editor"),
      ),
    ).toBe(false);
  });

  it("maps basic control keys to terminal sequences", () => {
    expect(recoveredTerminalInput({ key: "Enter" })).toBe("\r");
    expect(recoveredTerminalInput({ key: "Backspace" })).toBe("\x7f");
    expect(recoveredTerminalInput({ key: "Tab" })).toBe("\t");
    expect(recoveredTerminalInput({ key: "Escape" })).toBe("\x1b");
  });

  it("does not synthesize shortcut or IME input", () => {
    expect(recoveredTerminalInput({ key: "c", ctrlKey: true })).toBe(null);
    expect(recoveredTerminalInput({ key: "x", metaKey: true })).toBe(null);
    expect(recoveredTerminalInput({ key: "Process", keyCode: 229 })).toBe(null);
    expect(recoveredTerminalInput({ key: "a", isComposing: true })).toBe(null);
  });
});
