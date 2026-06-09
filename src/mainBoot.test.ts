import { describe, expect, it, vi } from "vitest";
import { startMainWindow } from "./mainBoot";

describe("startMainWindow", () => {
  it("waits for orphan PTY cleanup before rendering the first terminal", async () => {
    const timers: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void) => {
      timers.push(callback);
      return 1;
    });
    const show = vi.fn(() => Promise.resolve());
    const setFocus = vi.fn(() => Promise.resolve());
    const createRoot = vi.fn(() => ({ render: vi.fn() }));
    let finishCleanup!: () => void;
    const blockedCloseAll = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    const boot = startMainWindow({
      app: null,
      closeAllPtys: () => blockedCloseAll,
      createRoot,
      currentWindow: { show, setFocus },
      initLaunchDir: () => Promise.resolve(),
      logError: vi.fn(),
      root: {} as HTMLElement,
      setTimer,
    });

    expect(setTimer).toHaveBeenCalledTimes(2);
    timers[0]?.();
    expect(show).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(setFocus).toHaveBeenCalledTimes(1));

    timers[1]?.();
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(setFocus).toHaveBeenCalledTimes(2));
    expect(createRoot).not.toHaveBeenCalled();

    finishCleanup();
    await boot;
    expect(createRoot).toHaveBeenCalledTimes(1);
  });
});
