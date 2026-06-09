import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openPty } from "./pty-bridge";

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return {
    Channel,
    invoke: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(() => Promise.resolve()),
}));

const mockedInvoke = vi.mocked(invoke);

type PtyOpenArgs = {
  onData: { onmessage: (message: ArrayBuffer) => void };
};

describe("openPty", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers early PTY output until after the caller receives the writer", async () => {
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "pty_open") {
        (args as PtyOpenArgs).onData.onmessage(new Uint8Array([65]).buffer);
        return 42;
      }
      return undefined;
    });
    const received: number[][] = [];

    const pty = await openPty(
      80,
      24,
      { onData: (bytes) => received.push([...bytes]) },
      { kind: "local" },
    );

    expect(pty.id).toBe(42);
    expect(received).toEqual([]);

    vi.runOnlyPendingTimers();

    expect(received).toEqual([[65]]);
  });

  it("drops buffered output when the PTY closes before the deferred flush", async () => {
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "pty_open") {
        (args as PtyOpenArgs).onData.onmessage(new Uint8Array([65]).buffer);
        return 42;
      }
      return undefined;
    });
    const received: number[][] = [];

    const pty = await openPty(
      80,
      24,
      { onData: (bytes) => received.push([...bytes]) },
      { kind: "local" },
    );
    await pty.close();
    vi.runOnlyPendingTimers();

    expect(mockedInvoke).toHaveBeenCalledWith("pty_close", { id: 42 });
    expect(received).toEqual([]);
  });

  it("serializes writes so startup terminal replies stay ahead of user input", async () => {
    let releaseFirstWrite!: () => void;
    const writes: string[] = [];
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "pty_open") return Promise.resolve(42);
      if (command === "pty_write") {
        const data = (args as { data: string }).data;
        writes.push(data);
        if (data === "\x1b[1;1R") {
          return new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
      }
      return Promise.resolve(undefined);
    });

    const pty = await openPty(
      80,
      24,
      { onData: () => {} },
      { kind: "local" },
    );

    const terminalReply = pty.write("\x1b[1;1R");
    const userInput = pty.write("a");
    await Promise.resolve();

    expect(writes).toEqual(["\x1b[1;1R"]);

    releaseFirstWrite();
    await terminalReply;
    await userInput;

    expect(writes).toEqual(["\x1b[1;1R", "a"]);
  });
});
