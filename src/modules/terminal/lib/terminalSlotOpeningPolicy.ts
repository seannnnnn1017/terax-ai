export type SlotOpeningPolicyInput = {
  existingSlotForLeaf: boolean;
  poolSize: number;
  poolMaxSize: number;
};

export function shouldCreateFreshSlot({
  existingSlotForLeaf,
  poolSize,
  poolMaxSize,
}: SlotOpeningPolicyInput): boolean {
  return !existingSlotForLeaf && poolSize < poolMaxSize;
}
