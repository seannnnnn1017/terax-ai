import { describe, expect, it, vi } from "vitest";
import { afterTwoPaintsOrTimeout, type PaintScheduler } from "./paintScheduler";

function fakeScheduler() {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const scheduler: PaintScheduler = {
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, () => {
        frames.delete(id);
        callback();
      });
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
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
  return { frames, timers, scheduler };
}

describe("afterTwoPaintsOrTimeout", () => {
  it("runs after two animation frames and cancels the fallback timer", () => {
    const { frames, timers, scheduler } = fakeScheduler();
    const callback = vi.fn();

    afterTwoPaintsOrTimeout(callback, scheduler);
    expect(frames.size).toBe(1);
    expect(timers.size).toBe(1);

    frames.values().next().value?.();
    expect(callback).not.toHaveBeenCalled();
    frames.values().next().value?.();

    expect(callback).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
  });

  it("runs from the fallback when animation frames are suspended", () => {
    const { frames, timers, scheduler } = fakeScheduler();
    const callback = vi.fn();

    afterTwoPaintsOrTimeout(callback, scheduler);
    timers.values().next().value?.();

    expect(callback).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("can be cancelled before either path runs", () => {
    const { frames, timers, scheduler } = fakeScheduler();
    const callback = vi.fn();

    const cancel = afterTwoPaintsOrTimeout(callback, scheduler);
    cancel();

    expect(callback).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });
});
