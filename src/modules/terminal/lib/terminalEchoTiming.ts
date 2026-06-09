export type TerminalEchoLog = (message: string) => void;

type EchoState = {
  inputAt: number;
  dataLogged: boolean;
  parseLogged: boolean;
};

export class TerminalEchoTiming {
  private readonly states = new Map<number, EchoState>();

  markInput(leafId: number, data: string, now = performance.now()): void {
    if (isTerminalResponse(data)) return;
    if (this.states.has(leafId)) return;
    this.states.set(leafId, {
      inputAt: now,
      dataLogged: false,
      parseLogged: false,
    });
  }

  markPtyBytes(
    leafId: number,
    now = performance.now(),
    log: TerminalEchoLog = () => {},
  ): void {
    const state = this.states.get(leafId);
    if (!state || state.dataLogged) return;
    state.dataLogged = true;
    log(
      `terminal first PTY data after input leaf=${leafId} after ${Math.round(now - state.inputAt)}ms`,
    );
  }

  markParsed(
    leafId: number,
    now = performance.now(),
    log: TerminalEchoLog = () => {},
  ): void {
    const state = this.states.get(leafId);
    if (!state || state.parseLogged) return;
    state.parseLogged = true;
    log(
      `terminal first xterm parse after input leaf=${leafId} after ${Math.round(now - state.inputAt)}ms`,
    );
  }
}

export const terminalEchoTiming = new TerminalEchoTiming();

function isTerminalResponse(data: string): boolean {
  if (data === "\x1b[I" || data === "\x1b[O") return true;
  if (data.startsWith("\x1b]")) return true;
  if (data.length < 4 || !data.startsWith("\x1b[")) return false;
  const finalByte = data.charCodeAt(data.length - 1);
  const final = String.fromCharCode(finalByte);
  if (final !== "R" && final !== "c" && final !== "n") return false;
  const params = data.slice(2, -1);
  return /^[0-9;?><=]*$/.test(params);
}
