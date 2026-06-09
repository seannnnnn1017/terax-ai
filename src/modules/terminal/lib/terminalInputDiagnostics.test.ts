import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  summarizeTerminalData,
  TerminalInputDiagnostics,
} from "./terminalInputDiagnostics";

describe("TerminalInputDiagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("summarizes input without exposing the typed text", () => {
    expect(summarizeTerminalData("secret")).toBe(
      "chars=6 printable=6 control=0 cr=0 lf=0 esc=0 kind=printable-ascii",
    );
    expect(summarizeTerminalData("\r")).toContain("kind=enter");
    expect(summarizeTerminalData("\x1b[A")).toContain("kind=csi");
  });

  it("warns when user input has no PTY output within the watchdog window", () => {
    const log = vi.fn();
    const diagnostics = new TerminalInputDiagnostics();

    diagnostics.markInput(2, "xterm-onData", "a", 10, log);
    vi.advanceTimersByTime(4_999);

    expect(log).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toContain("terminal input no PTY output");
  });

  it("logs output and parse latency after input", () => {
    const log = vi.fn();
    const diagnostics = new TerminalInputDiagnostics();

    diagnostics.markInput(2, "xterm-onData", "a", 10, log);
    diagnostics.markPtyBytes(2, new Uint8Array([65]), 30, log);
    diagnostics.markParsed(2, 45, log);

    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "terminal input queued leaf=2 seq=1 source=xterm-onData chars=1 printable=1 control=0 cr=0 lf=0 esc=0 kind=printable-ascii",
      "terminal input PTY output leaf=2 seq=1 source=xterm-onData after=20ms bytes=1 warned=false",
      "terminal input xterm parsed leaf=2 seq=1 source=xterm-onData afterInput=35ms afterOutput=15ms bytes=1",
    ]);
  });

  it("ignores terminal protocol responses", () => {
    const log = vi.fn();
    const diagnostics = new TerminalInputDiagnostics();

    expect(diagnostics.markInput(2, "xterm-onData", "\x1b[1;1R", 10, log)).toBe(
      null,
    );
    expect(log).not.toHaveBeenCalled();
  });
});
