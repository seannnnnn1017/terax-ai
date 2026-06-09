import { describe, expect, it, vi } from "vitest";
import { TerminalInputBuffer } from "./terminalInputBuffer";

describe("TerminalInputBuffer", () => {
  it("preserves input typed before the PTY is ready", () => {
    const input = new TerminalInputBuffer();
    const write = vi.fn();

    input.push("echo ready");
    input.push("\r");
    input.flush(write);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("echo ready\r");
    expect(input.length).toBe(0);
  });

  it("bounds input retained while the PTY is opening", () => {
    const input = new TerminalInputBuffer(5);
    const write = vi.fn();

    input.push("abcdef");
    input.flush(write);

    expect(write).toHaveBeenCalledWith("abcde");
  });
});
