import { invoke } from "@tauri-apps/api/core";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { DormantRing } from "./dormantRing";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
  type Osc7Location,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import {
  acquireSlot,
  applyBackgroundActive,
  applyFontFamily,
  applyFontSize,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  focusSlot,
  getSlotForLeaf,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";
import { withCurrentSession } from "./sessionEventRouting";
import { terminalEchoTiming } from "./terminalEchoTiming";
import { TerminalInputBuffer } from "./terminalInputBuffer";
import { terminalInputDiagnostics } from "./terminalInputDiagnostics";
import { terminalRenderRecovery } from "./terminalRenderRecovery";
import { terminalSlotLifecycleAction } from "./terminalSlotLifecycle";
import { startTerminalBeforeRendererReady } from "./terminalStartup";

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string, host: string | null) => void;
  onCommandStart?: (command: string) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  workspace: WorkspaceEnv;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  rendererReady: boolean;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  hasSlot: boolean;
  createdAt: number;
  lastDormantLogAt: number;
  outputLogCount: number;
  lastOutputLogAt: number;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  pendingInput: TerminalInputBuffer;
};

const sessions = new Map<number, Session>();

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(leafId: number, timeoutMs = 4000): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  return s ? writeSessionInput(s, data) : false;
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line — macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      plainCtrlVPaste: s.workspace.kind === "wsl",
      writeToPty: (data) => {
        terminalEchoTiming.markInput(leafId, data);
        terminalInputDiagnostics.markInput(
          leafId,
          "xterm-onData",
          data,
          performance.now(),
          logTerminalTiming,
        );
        writeSessionInput(s, data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        pty
          .resize(cols, rows + 1)
          .then(() => pty.resize(cols, rows))
          .catch((e) => console.warn("[terax] kickPty failed:", e));
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.focusedNow;
  },
  isLeafVisible(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow;
  },
});

function ensureSession(leafId: number, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    workspace: { kind: "local" },
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    rendererReady: false,
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: new DormantRing(),
    hasSlot: false,
    createdAt: performance.now(),
    lastDormantLogAt: 0,
    outputLogCount: 0,
    lastOutputLogAt: 0,
    altScreenAtRelease: false,
    pendingInput: new TerminalInputBuffer(),
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function writeSessionInput(s: Session, data: string): boolean {
  if (s.disposed || s.shellExited) return false;
  if (s.pty) {
    void s.pty.write(data);
  } else {
    s.pendingInput.push(data);
  }
  return true;
}

function logTerminalTiming(message: string): void {
  void logInfo(message).catch(() => {});
}

function connectPty(s: Session, pty: PtySession): void {
  s.pendingInput.flush((data) => {
    void pty.write(data);
  });
  s.pty = pty;
}

function deliverPtyBytes(
  leafId: number,
  source: Session,
  bytes: Uint8Array,
): void {
  withCurrentSession(sessions.get(leafId), source, (s) => {
    const slot = getSlotForLeaf(leafId);
    if (slot) {
      const now = performance.now();
      s.outputLogCount += 1;
      const outputSeq = s.outputLogCount;
      const shouldLogOutput =
        outputSeq <= 5 ||
        bytes.length >= 8192 ||
        now - s.lastOutputLogAt >= 5000;
      if (shouldLogOutput) {
        s.lastOutputLogAt = now;
        // DOM truth alongside React state: a pane can claim visible/focused
        // while its slot host is detached, hidden, or lacks DOM focus.
        const hostConnected = slot.host.isConnected;
        const hostVis = slot.host.style.visibility || "visible";
        const termHasFocus =
          slot.term.element?.contains(document.activeElement) ?? false;
        logTerminalTiming(
          `terminal PTY output delivered to renderer leaf=${leafId} seq=${outputSeq} bytes=${bytes.length} sessionAge=${Math.round(now - s.createdAt)}ms rendererReady=${s.rendererReady} visible=${s.visibleNow} focused=${s.focusedNow} hostConnected=${hostConnected} hostVis=${hostVis} termHasFocus=${termHasFocus} docFocus=${document.hasFocus()}`,
        );
      }
      terminalInputDiagnostics.markPtyBytes(
        leafId,
        bytes,
        now,
        logTerminalTiming,
      );
      terminalEchoTiming.markPtyBytes(leafId, now, logTerminalTiming);
      let writeWatchdog: ReturnType<typeof setTimeout> | null = null;
      const writeStartedAt = now;
      if (shouldLogOutput) {
        writeWatchdog = setTimeout(() => {
          writeWatchdog = null;
          logTerminalTiming(
            `terminal xterm write callback pending leaf=${leafId} seq=${outputSeq} age=5000ms bytes=${bytes.length}`,
          );
        }, 5000);
      }
      slot.term.write(bytes, () => {
        if (writeWatchdog !== null) {
          clearTimeout(writeWatchdog);
          writeWatchdog = null;
        }
        if (shouldLogOutput) {
          logTerminalTiming(
            `terminal xterm write callback leaf=${leafId} seq=${outputSeq} after=${Math.round(performance.now() - writeStartedAt)}ms bytes=${bytes.length}`,
          );
        }
        terminalInputDiagnostics.markParsed(
          leafId,
          performance.now(),
          logTerminalTiming,
        );
        terminalEchoTiming.markParsed(
          leafId,
          performance.now(),
          logTerminalTiming,
        );
        terminalRenderRecovery.requestRefresh(
          leafId,
          slot.term,
          shouldLogOutput ? logTerminalTiming : null,
        );
      });
      terminalRenderRecovery.requestRefresh(
        leafId,
        slot.term,
        shouldLogOutput ? logTerminalTiming : null,
      );
    } else {
      const now = performance.now();
      const before = s.dormantRing.byteLength();
      s.dormantRing.push(bytes);
      const dormantBytes = s.dormantRing.byteLength();
      if (before === 0 || now - s.lastDormantLogAt >= 5000) {
        s.lastDormantLogAt = now;
        logTerminalTiming(
          `terminal PTY output buffered without renderer leaf=${leafId} bytes=${bytes.length} dormantBytes=${dormantBytes} sessionAge=${Math.round(now - s.createdAt)}ms rendererReady=${s.rendererReady} visible=${s.visibleNow} focused=${s.focusedNow} hasContainer=${!!s.container}`,
        );
      }
    }
  });
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  workspace: WorkspaceEnv,
  cwd: string | undefined,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  return openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, s, bytes),
      onExit: (code) => {
        withCurrentSession(sessions.get(leafId), s, (current) => {
          current.shellExited = true;
          current.pty = null;
          current.pendingInput.clear();
          const slot = getSlotForLeaf(leafId);
          if (slot) slot.term.options.disableStdin = true;
          if (current.callbacks.onExit) current.callbacks.onExit(code);
          else current.pendingExit = code;
        });
      },
    },
    workspace,
    cwd,
  );
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container || !s.rendererReady) return;
  const dormantBytes = s.dormantRing.byteLength();
  if (dormantBytes > 0) {
    logTerminalTiming(
      `terminal renderer binding with buffered output leaf=${leafId} dormantBytes=${dormantBytes} sessionAge=${Math.round(performance.now() - s.createdAt)}ms`,
    );
  }
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    shellExited: s.shellExited,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      // Shared in-command flag — see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();
      const prompt = registerPromptTracker(term, shellState, {
        onCommandStart: (command) => s.callbacks.onCommandStart?.(command),
      });
      const cwd = registerCwdHandler(
        term,
        (next: Osc7Location) => {
          markSessionReady(leafId);
          if (s.lastCwd === next.cwd) return;
          s.lastCwd = next.cwd;
          s.callbacks.onCwd?.(next.cwd, next.host);
        },
        shellState,
      );
      return [prompt.dispose, cwd];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd, null);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  terminalRenderRecovery.disposeLeaf(leafId);
  const out = releaseSlot(leafId);
  if (out) {
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  }
  s.hasSlot = false;
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  workspace: WorkspaceEnv,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    openPtyForSession(leafId, s, workspace, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed || s.shellExited) {
          s.pendingInput.clear();
          pty.close();
          return;
        }
        connectPty(s, pty);
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        s.ptyOpening = false;
        s.pendingInput.clear();
        console.error("[terax] openPty failed:", e);
      });
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.pty?.close();
  s.pty = null;
  s.pendingInput.clear();
  s.snapshot = null;
  s.dormantRing = new DormantRing();
  s.createdAt = performance.now();
  s.lastDormantLogAt = 0;
  s.outputLogCount = 0;
  s.lastOutputLogAt = 0;
  s.shellExited = false;
  s.pendingExit = null;
  s.altScreenAtRelease = false;

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  }

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyForSession(leafId, s, s.workspace, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    s.pendingInput.clear();
    console.error("[terax] respawn openPty failed:", e);
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  connectPty(s, pty);
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

export async function leafHasForegroundProcess(leafId: number): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", { id: s.pty.id });
    return result;
  } catch (e) {
    console.error("[terax] pty_has_foreground_process failed for leaf", leafId, e);
    return false;
  }
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  unbindLeafFromSlot(leafId, s);
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  s.pendingInput.clear();
  terminalRenderRecovery.disposeLeaf(leafId);
  sessions.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  workspace: WorkspaceEnv;
  workspaceKey: string;
  workspaceNonce: number;
  initialCwd?: string;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string, host: string | null) => void;
  onCommandStart?: (command: string) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  workspace,
  workspaceKey,
  workspaceNonce,
  initialCwd,
  onSearchReady,
  onExit,
  onCwd,
  onCommandStart,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd });
  cbRef.current = { onSearchReady, onExit, onCwd };
  const commandStartRef = useRef(onCommandStart);
  commandStartRef.current = onCommandStart;
  const workspaceRef = useRef(workspace);
  const workspaceKeyRef = useRef(workspaceKey);
  const workspaceNonceRef = useRef(workspaceNonce);
  const visibleRef = useRef(visible);
  const focusedRef = useRef(focused);

  useEffect(() => {
    visibleRef.current = visible;
    focusedRef.current = focused;
  }, [visible, focused]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (s) s.workspace = workspace;
  }, [leafId, workspace]);

  useEffect(() => {
    let cancelled = false;
    const nextWorkspaceKey = workspaceKey;
    const workspaceChanged = workspaceKeyRef.current !== nextWorkspaceKey;
    const nonceChanged = workspaceNonceRef.current !== workspaceNonce;
    if (workspaceChanged || nonceChanged) {
      workspaceKeyRef.current = nextWorkspaceKey;
      workspaceNonceRef.current = workspaceNonce;
      disposeSession(leafId);
    }
    const s = ensureSession(leafId, initialCwd);
    s.visibleNow = visibleRef.current;
    s.focusedNow = focusedRef.current;
    const node = container.current;
    if (!node) return;
    s.workspace = workspaceRef.current;
    s.visibleNow = visibleRef.current;
    s.focusedNow = focusedRef.current;
    void startTerminalBeforeRendererReady(
      () =>
        attachSession(leafId, node, workspaceRef.current, {
          onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
          onExit: (c) => cbRef.current.onExit?.(c),
          onCwd: (c, host) => cbRef.current.onCwd?.(c, host),
          onCommandStart: (command) => commandStartRef.current?.(command),
        }),
      s.ready,
      () => {
        if (cancelled || s.disposed) return;
        s.rendererReady = true;
        if (s.visibleNow) bindLeafToSlot(leafId, s);
        if (s.visibleNow && s.focusedNow) focusSlot(leafId);
      },
      {
        log: (message) => logTerminalTiming(`${message} leaf=${leafId}`),
      },
    );
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, initialCwd, workspaceKey, workspaceNonce]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const fontFamily = usePreferencesStore((p) => p.terminalFontFamily);
  useEffect(() => {
    applyFontFamily(fontFamily);
  }, [fontFamily]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    const action = terminalSlotLifecycleAction({
      visible,
      focused,
      rendererReady: s.rendererReady,
      hasContainer: !!s.container,
      hasSlot: s.hasSlot,
    });
    if (action.shouldBind) {
      bindLeafToSlot(leafId, s);
    }
    if (s.hasSlot) {
      setSlotFocused(leafId, action.slotFocused);
    }
    if (action.shouldFocus) {
      focusSlot(leafId);
    }
    if (action.shouldRelease) {
      unbindLeafFromSlot(leafId, s);
    }
  }, [leafId, visible, focused]);

  const write = useCallback(
    (data: string) => {
      const s = sessions.get(leafId);
      if (s) {
        terminalInputDiagnostics.markInput(
          leafId,
          "session-write",
          data,
          performance.now(),
          logTerminalTiming,
        );
        writeSessionInput(s, data);
      }
    },
    [leafId],
  );

  const focus = useCallback(() => {
    const s = sessions.get(leafId);
    if (s?.rendererReady && s.visibleNow && s.container && !s.hasSlot) {
      bindLeafToSlot(leafId, s);
    }
    focusSlot(leafId);
  }, [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  return useMemo(
    () => ({ write, focus, getBuffer, getSelection, applyTheme }),
    [write, focus, getBuffer, getSelection, applyTheme],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
