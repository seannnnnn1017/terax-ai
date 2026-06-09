import { describe, expect, it, vi } from "vitest";
import {
  classifyTerminalFocusOwner,
  focusTerminalInput,
  restoreTerminalFocus,
} from "./focusRecovery";

describe("terminal focus recovery", () => {
  it("restores a terminal when the window has no focused control", () => {
    const focus = vi.fn();

    expect(restoreTerminalFocus({ focus }, "none")).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not steal focus from another control", () => {
    const focus = vi.fn();

    expect(restoreTerminalFocus({ focus }, "other")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("classifies document and terminal focus owners", () => {
    const body = {} as Element;
    const root = {} as Element;
    const terminal = {
      closest: (selector: string) => (selector === ".xterm" ? {} : null),
    } as Element;
    const input = { closest: () => null } as unknown as Element;

    expect(classifyTerminalFocusOwner(null, body, root)).toBe("none");
    expect(classifyTerminalFocusOwner(body, body, root)).toBe("none");
    expect(classifyTerminalFocusOwner(root, body, root)).toBe("none");
    expect(classifyTerminalFocusOwner(terminal, body, root)).toBe("terminal");
    expect(classifyTerminalFocusOwner(input, body, root)).toBe("other");
  });

  it("focuses xterm helper textarea when terminal focus leaves focus outside the slot", () => {
    const outside = {} as Element;
    const doc: { activeElement: Element | null } = { activeElement: outside };
    const helperFocus = vi.fn(() => {
      doc.activeElement = helper;
    });
    const helper = { focus: helperFocus } as unknown as HTMLTextAreaElement;
    const host = {
      contains: (el: Element | null) => el === helper,
      querySelector: (selector: string) =>
        selector === ".xterm-helper-textarea" ? helper : null,
    } as unknown as HTMLElement;
    const termFocus = vi.fn(() => {
      doc.activeElement = outside;
    });
    const term = {
      focus: termFocus,
    };

    expect(focusTerminalInput(term, host, doc)).toBe(true);
    expect(termFocus).toHaveBeenCalledOnce();
    expect(helperFocus).toHaveBeenCalledOnce();
  });

  it("focuses xterm helper textarea when another slot child is focused", () => {
    const screen = {} as Element;
    const doc: { activeElement: Element | null } = { activeElement: screen };
    const helperFocus = vi.fn(() => {
      doc.activeElement = helper;
    });
    const helper = { focus: helperFocus } as unknown as HTMLTextAreaElement;
    const host = {
      contains: (el: Element | null) => el === screen || el === helper,
      querySelector: (selector: string) =>
        selector === ".xterm-helper-textarea" ? helper : null,
    } as unknown as HTMLElement;
    const termFocus = vi.fn(() => {
      doc.activeElement = screen;
    });

    expect(focusTerminalInput({ focus: termFocus }, host, doc)).toBe(true);
    expect(helperFocus).toHaveBeenCalledOnce();
  });
});
