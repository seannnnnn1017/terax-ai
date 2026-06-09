import { describe, expect, it, vi } from "vitest";
import { withCurrentSession } from "./sessionEventRouting";

describe("withCurrentSession", () => {
  it("rejects events from a disposed session after its leaf id is reused", () => {
    const current = {};
    const stale = {};
    const deliver = vi.fn();

    expect(withCurrentSession(current, stale, deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers events from the current session", () => {
    const current = {};
    const deliver = vi.fn();

    expect(withCurrentSession(current, current, deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledWith(current);
  });
});
