import { describe, expect, it, vi } from "vitest";
import { TerminalRenderRecovery, type RenderRecoveryScheduler } from "./terminalRenderRecovery";

function fakeScheduler(nowRef: { value: number }) {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const scheduler: RenderRecoveryScheduler = {
    now: () => nowRef.value,
    setTimer: (callback) => {
      const id = nextId++;
      timers.set(id, () => {
        timers.delete(id);
        callback();
      });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
  };
  return { timers, scheduler };
}

describe("TerminalRenderRecovery", () => {
  it("coalesces refresh requests for the same leaf", () => {
    const nowRef = { value: 0 };
    const { timers, scheduler } = fakeScheduler(nowRef);
    const recovery = new TerminalRenderRecovery(100, scheduler);
    const term = { rows: 24, refresh: vi.fn() };

    recovery.requestRefresh(2, term);
    recovery.requestRefresh(2, term);

    expect(timers.size).toBe(1);
    timers.values().next().value?.();

    expect(term.refresh).toHaveBeenCalledOnce();
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
  });

  it("throttles refreshes after a recent refresh", () => {
    const nowRef = { value: 0 };
    const { timers, scheduler } = fakeScheduler(nowRef);
    const recovery = new TerminalRenderRecovery(100, scheduler);
    const term = { rows: 24, refresh: vi.fn() };

    recovery.requestRefresh(2, term);
    timers.values().next().value?.();
    nowRef.value = 50;
    recovery.requestRefresh(2, term);

    expect(timers.size).toBe(1);
    expect(term.refresh).toHaveBeenCalledOnce();
    timers.values().next().value?.();
    expect(term.refresh).toHaveBeenCalledTimes(2);
  });

  it("logs refresh failures without throwing", () => {
    const nowRef = { value: 0 };
    const { timers, scheduler } = fakeScheduler(nowRef);
    const recovery = new TerminalRenderRecovery(100, scheduler);
    const term = {
      rows: 24,
      refresh: vi.fn(() => {
        throw new Error("refresh failed");
      }),
    };
    const log = vi.fn();

    recovery.requestRefresh(2, term, log);
    timers.values().next().value?.();

    expect(log).toHaveBeenCalledWith(
      "terminal render refresh failed leaf=2 error=Error: refresh failed",
    );
  });
});
