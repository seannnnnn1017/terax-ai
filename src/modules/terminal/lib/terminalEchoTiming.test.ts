import { describe, expect, it, vi } from "vitest";
import { TerminalEchoTiming } from "./terminalEchoTiming";

describe("TerminalEchoTiming", () => {
  it("logs the first PTY data and parse timing after user input once", () => {
    const log = vi.fn();
    const timing = new TerminalEchoTiming();

    timing.markPtyBytes(2, 5, log);
    timing.markInput(2, "a", 10);
    timing.markPtyBytes(2, 25, log);
    timing.markParsed(2, 40, log);
    timing.markPtyBytes(2, 60, log);
    timing.markParsed(2, 70, log);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toContain(
      "terminal first PTY data after input leaf=2 after 15ms",
    );
    expect(log.mock.calls[1]?.[0]).toContain(
      "terminal first xterm parse after input leaf=2 after 30ms",
    );
  });

  it("ignores terminal protocol responses as input", () => {
    const log = vi.fn();
    const timing = new TerminalEchoTiming();

    timing.markInput(2, "\x1b[?1;2c", 10);
    timing.markInput(2, "a", 20);
    timing.markPtyBytes(2, 35, log);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("after 15ms");
  });
});
