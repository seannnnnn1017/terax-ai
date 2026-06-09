export type RenderRecoveryLog = (message: string) => void;

export type RenderRecoveryScheduler = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (id: number) => void;
};

export type RenderRecoveryTarget = {
  rows: number;
  refresh(start: number, end: number): void;
};

type LeafState = {
  timer: number | null;
  lastRefreshAt: number;
  pendingTerm: RenderRecoveryTarget | null;
  pendingLog: RenderRecoveryLog | null;
};

const DEFAULT_MIN_REFRESH_INTERVAL_MS = 100;

function browserScheduler(): RenderRecoveryScheduler {
  return {
    now: () => performance.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (id) => clearTimeout(id),
  };
}

export class TerminalRenderRecovery {
  private readonly states = new Map<number, LeafState>();

  constructor(
    private readonly minRefreshIntervalMs = DEFAULT_MIN_REFRESH_INTERVAL_MS,
    private readonly scheduler = browserScheduler(),
  ) {}

  requestRefresh(
    leafId: number,
    term: RenderRecoveryTarget,
    log: RenderRecoveryLog | null = null,
  ): void {
    const now = this.scheduler.now();
    const state = this.states.get(leafId) ?? {
      timer: null,
      lastRefreshAt: Number.NEGATIVE_INFINITY,
      pendingTerm: null,
      pendingLog: null,
    };
    state.pendingTerm = term;
    if (log) state.pendingLog = log;
    this.states.set(leafId, state);
    if (state.timer !== null) return;

    const elapsed = now - state.lastRefreshAt;
    const delayMs =
      elapsed >= this.minRefreshIntervalMs
        ? 0
        : this.minRefreshIntervalMs - elapsed;
    state.timer = this.scheduler.setTimer(() => {
      state.timer = null;
      state.lastRefreshAt = this.scheduler.now();
      const target = state.pendingTerm;
      const pendingLog = state.pendingLog;
      state.pendingTerm = null;
      state.pendingLog = null;
      if (!target || target.rows <= 0) return;
      try {
        target.refresh(0, target.rows - 1);
      } catch (e) {
        pendingLog?.(
          `terminal render refresh failed leaf=${leafId} error=${String(e)}`,
        );
      }
    }, delayMs);
  }

  disposeLeaf(leafId: number): void {
    const state = this.states.get(leafId);
    if (!state) return;
    if (state.timer !== null) this.scheduler.clearTimer(state.timer);
    this.states.delete(leafId);
  }
}

export const terminalRenderRecovery = new TerminalRenderRecovery();
