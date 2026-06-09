import { describe, expect, it } from "vitest";
import { agentStatusLabel } from "./status";

describe("agentStatusLabel", () => {
  it("keeps working, waiting, and finished distinct", () => {
    expect(agentStatusLabel("working")).toBe("working");
    expect(agentStatusLabel("waiting")).toBe("waiting");
    expect(agentStatusLabel("finished")).toBe("finished");
  });
});
