export type TerminalSlotLifecycleInput = {
  visible: boolean;
  focused: boolean;
  rendererReady: boolean;
  hasContainer: boolean;
  hasSlot: boolean;
};

export type TerminalSlotLifecycleAction = {
  shouldBind: boolean;
  shouldFocus: boolean;
  shouldRelease: boolean;
  slotFocused: boolean;
};

export function terminalSlotLifecycleAction({
  visible,
  focused,
  rendererReady,
  hasContainer,
  hasSlot,
}: TerminalSlotLifecycleInput): TerminalSlotLifecycleAction {
  const active = visible && focused;
  return {
    shouldBind: visible && rendererReady && hasContainer && !hasSlot,
    shouldFocus: active,
    shouldRelease: false,
    slotFocused: active,
  };
}
