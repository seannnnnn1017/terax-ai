import { describe, expect, it, vi } from "vitest";
import { PtyOutputGate } from "./ptyOutputGate";

describe("PtyOutputGate", () => {
  it("buffers PTY output until input writer setup can finish", () => {
    const deliver = vi.fn();
    const gate = new PtyOutputGate(deliver);
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);

    gate.receive(first);
    gate.receive(second);

    expect(deliver).not.toHaveBeenCalled();

    gate.open();

    expect(deliver).toHaveBeenNthCalledWith(1, first);
    expect(deliver).toHaveBeenNthCalledWith(2, second);
  });

  it("delivers later output immediately after opening", () => {
    const deliver = vi.fn();
    const gate = new PtyOutputGate(deliver);
    const bytes = new Uint8Array([3]);

    gate.open();
    gate.receive(bytes);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(bytes);
  });

  it("drops buffered output after release", () => {
    const deliver = vi.fn();
    const gate = new PtyOutputGate(deliver);

    gate.receive(new Uint8Array([1]));
    gate.release();
    gate.open();
    gate.receive(new Uint8Array([2]));

    expect(deliver).not.toHaveBeenCalled();
  });
});
