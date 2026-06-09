import { describe, expect, it } from "vitest";
import { terminalSlotLifecycleAction } from "./terminalSlotLifecycle";

describe("terminal slot lifecycle", () => {
  it("retains an already-bound hidden slot so background output stays in xterm", () => {
    expect(
      terminalSlotLifecycleAction({
        visible: false,
        focused: true,
        rendererReady: true,
        hasContainer: true,
        hasSlot: true,
      }),
    ).toEqual({
      shouldBind: false,
      shouldFocus: false,
      shouldRelease: false,
      slotFocused: false,
    });
  });

  it("binds and focuses a visible focused terminal without releasing it", () => {
    expect(
      terminalSlotLifecycleAction({
        visible: true,
        focused: true,
        rendererReady: true,
        hasContainer: true,
        hasSlot: false,
      }),
    ).toEqual({
      shouldBind: true,
      shouldFocus: true,
      shouldRelease: false,
      slotFocused: true,
    });
  });
});
