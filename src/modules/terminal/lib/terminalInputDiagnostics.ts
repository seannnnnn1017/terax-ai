export type TerminalDiagnosticLog = (message: string) => void;

const WATCHDOG_MS = 5_000;

type PendingOutput = {
  seq: number;
  source: string;
  inputAt: number;
  summary: string;
  warned: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type PendingParse = {
  seq: number;
  source: string;
  inputAt: number;
  outputAt: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

export class TerminalInputDiagnostics {
  private nextSeq = 1;
  private readonly pendingOutput = new Map<number, PendingOutput[]>();
  private readonly pendingParse = new Map<number, PendingParse[]>();

  markInput(
    leafId: number,
    source: string,
    data: string,
    now = performance.now(),
    log: TerminalDiagnosticLog = () => {},
  ): number | null {
    if (isTerminalResponse(data)) return null;
    const seq = this.nextSeq++;
    const summary = summarizeTerminalData(data);
    const pending: PendingOutput = {
      seq,
      source,
      inputAt: now,
      summary,
      warned: false,
      timer: setTimeout(() => {
        pending.warned = true;
        log(
          `terminal input no PTY output leaf=${leafId} seq=${seq} source=${source} age=${WATCHDOG_MS}ms ${summary}`,
        );
      }, WATCHDOG_MS),
    };
    const arr = this.pendingOutput.get(leafId) ?? [];
    arr.push(pending);
    this.pendingOutput.set(leafId, arr);
    log(`terminal input queued leaf=${leafId} seq=${seq} source=${source} ${summary}`);
    return seq;
  }

  markPtyBytes(
    leafId: number,
    bytes: Uint8Array,
    now = performance.now(),
    log: TerminalDiagnosticLog = () => {},
  ): void {
    const arr = this.pendingOutput.get(leafId);
    if (!arr?.length) return;
    this.pendingOutput.delete(leafId);

    const parseArr = this.pendingParse.get(leafId) ?? [];
    for (const pending of arr) {
      clearTimeout(pending.timer);
      log(
        `terminal input PTY output leaf=${leafId} seq=${pending.seq} source=${pending.source} after=${Math.round(now - pending.inputAt)}ms bytes=${bytes.length} warned=${pending.warned}`,
      );
      const parsePending: PendingParse = {
        seq: pending.seq,
        source: pending.source,
        inputAt: pending.inputAt,
        outputAt: now,
        bytes: bytes.length,
        timer: setTimeout(() => {
          log(
            `terminal input no xterm parse leaf=${leafId} seq=${pending.seq} source=${pending.source} age=${WATCHDOG_MS}ms bytes=${bytes.length}`,
          );
        }, WATCHDOG_MS),
      };
      parseArr.push(parsePending);
    }
    this.pendingParse.set(leafId, parseArr);
  }

  markParsed(
    leafId: number,
    now = performance.now(),
    log: TerminalDiagnosticLog = () => {},
  ): void {
    const arr = this.pendingParse.get(leafId);
    if (!arr?.length) return;
    this.pendingParse.delete(leafId);
    for (const pending of arr) {
      clearTimeout(pending.timer);
      log(
        `terminal input xterm parsed leaf=${leafId} seq=${pending.seq} source=${pending.source} afterInput=${Math.round(now - pending.inputAt)}ms afterOutput=${Math.round(now - pending.outputAt)}ms bytes=${pending.bytes}`,
      );
    }
  }
}

export const terminalInputDiagnostics = new TerminalInputDiagnostics();

export function summarizeTerminalData(data: string): string {
  let printable = 0;
  let control = 0;
  let cr = 0;
  let lf = 0;
  let esc = 0;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 0x1b) esc += 1;
    else if (code === 0x0d) cr += 1;
    else if (code === 0x0a) lf += 1;
    else if (code >= 0x20 && code !== 0x7f) printable += 1;
    else control += 1;
  }
  return `chars=${data.length} printable=${printable} control=${control} cr=${cr} lf=${lf} esc=${esc} kind=${inputKind(data)}`;
}

function inputKind(data: string): string {
  if (data === "\r") return "enter";
  if (data === "\x7f") return "backspace";
  if (data === "\t") return "tab";
  if (data === "\x1b") return "escape";
  if (data.startsWith("\x1b[")) return "csi";
  if (data.startsWith("\x1b]")) return "osc";
  if (/^[\x20-\x7e]+$/.test(data)) return "printable-ascii";
  return "mixed";
}

function isTerminalResponse(data: string): boolean {
  if (data === "\x1b[I" || data === "\x1b[O") return true;
  if (data.startsWith("\x1b]")) return true;
  if (data.length < 4 || !data.startsWith("\x1b[")) return false;
  const final = data[data.length - 1];
  if (final !== "R" && final !== "c" && final !== "n") return false;
  return /^[0-9;?><=]*$/.test(data.slice(2, -1));
}
