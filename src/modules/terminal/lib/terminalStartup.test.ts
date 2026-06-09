import { describe, expect, it, vi } from "vitest";
import { startTerminalBeforeRendererReady } from "./terminalStartup";

describe("startTerminalBeforeRendererReady", () => {
  it("starts the PTY before waiting for fonts and renderer setup", async () => {
    let resolveRenderer!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRenderer = resolve;
    });
    const startPty = vi.fn();
    const bindRenderer = vi.fn();

    const done = startTerminalBeforeRendererReady(
      startPty,
      rendererReady,
      bindRenderer,
    );

    expect(startPty).toHaveBeenCalledOnce();
    expect(bindRenderer).not.toHaveBeenCalled();

    resolveRenderer();
    await done;

    expect(bindRenderer).toHaveBeenCalledOnce();
  });

  it("binds the renderer after a timeout when fonts do not settle", async () => {
    vi.useFakeTimers();
    try {
      const rendererReady = new Promise<void>(() => {});
      const startPty = vi.fn();
      const bindRenderer = vi.fn();
      const log = vi.fn();

      const done = startTerminalBeforeRendererReady(
        startPty,
        rendererReady,
        bindRenderer,
        { timeoutMs: 750, log },
      );

      expect(startPty).toHaveBeenCalledOnce();
      expect(bindRenderer).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(750);
      await done;

      expect(bindRenderer).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "terminal renderer readiness timed out after 750ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bind twice if fonts settle after the timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveRenderer!: () => void;
      const rendererReady = new Promise<void>((resolve) => {
        resolveRenderer = resolve;
      });
      const startPty = vi.fn();
      const bindRenderer = vi.fn();

      const done = startTerminalBeforeRendererReady(
        startPty,
        rendererReady,
        bindRenderer,
        { timeoutMs: 750 },
      );

      await vi.advanceTimersByTimeAsync(750);
      await done;
      resolveRenderer();
      await Promise.resolve();

      expect(bindRenderer).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
