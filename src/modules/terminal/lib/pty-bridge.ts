import { invoke, Channel } from "@tauri-apps/api/core";
import { info as logInfo } from "@tauri-apps/plugin-log";
import type { WorkspaceEnv } from "@/modules/workspace";
import { PtyOutputGate } from "./ptyOutputGate";
import { summarizeTerminalData } from "./terminalInputDiagnostics";

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

function logPtyBridge(message: string): void {
  void logInfo(message).catch(() => {});
}

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  workspace: WorkspaceEnv,
  cwd?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();
  const outputGate = new PtyOutputGate((bytes) => handlers.onData(bytes));

  let released = false;
  let outputGateTimer: ReturnType<typeof setTimeout> | null = null;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    if (outputGateTimer !== null) {
      clearTimeout(outputGateTimer);
      outputGateTimer = null;
    }
    outputGate.release();
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => outputGate.receive(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace,
    onData,
    onExit,
  });

  let closed = false;
  let writeQueue: Promise<void> = Promise.resolve();
  let writeSeq = 0;

  const write = (data: string): Promise<void> => {
    const seq = ++writeSeq;
    const queuedAt = performance.now();
    const summary = summarizeTerminalData(data);
    logPtyBridge(`terminal pty_write queued id=${id} seq=${seq} ${summary}`);
    const run = () => {
      const startedAt = performance.now();
      logPtyBridge(
        `terminal pty_write start id=${id} seq=${seq} wait=${Math.round(startedAt - queuedAt)}ms closed=${closed}`,
      );
      if (closed) return Promise.resolve();
      return invoke<void>("pty_write", { id, data })
        .then(() => {
          logPtyBridge(
            `terminal pty_write done id=${id} seq=${seq} duration=${Math.round(performance.now() - startedAt)}ms`,
          );
        })
        .catch((e) => {
          logPtyBridge(
            `terminal pty_write failed id=${id} seq=${seq} duration=${Math.round(performance.now() - startedAt)}ms error=${String(e)}`,
          );
          throw e;
        });
    };
    const result = writeQueue.then(run, run);
    writeQueue = result.catch(() => {});
    return result;
  };
  outputGateTimer = setTimeout(() => {
    outputGateTimer = null;
    outputGate.open();
  }, 0);

  return {
    id,
    write,
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
