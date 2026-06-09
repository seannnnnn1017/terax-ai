import { describe, expect, it } from "vitest";
import { shouldCreateFreshSlot } from "./terminalSlotOpeningPolicy";

describe("terminal slot opening policy", () => {
  it("creates fresh slots before reusing offscreen free slots", () => {
    expect(
      shouldCreateFreshSlot({
        existingSlotForLeaf: false,
        poolSize: 2,
        poolMaxSize: 5,
      }),
    ).toBe(true);
  });

  it("does not create fresh slots after the pool reaches its cap", () => {
    expect(
      shouldCreateFreshSlot({
        existingSlotForLeaf: false,
        poolSize: 5,
        poolMaxSize: 5,
      }),
    ).toBe(false);
  });

  it("does not create a fresh slot for an already-bound leaf", () => {
    expect(
      shouldCreateFreshSlot({
        existingSlotForLeaf: true,
        poolSize: 2,
        poolMaxSize: 5,
      }),
    ).toBe(false);
  });
});
