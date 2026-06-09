import { describe, expect, it, vi } from "vitest";
import type { CustomEndpoint } from "../config";
import { hydrateCustomEndpointKeys } from "./customEndpointKeyHydration";

describe("hydrateCustomEndpointKeys", () => {
  const endpoint: CustomEndpoint = {
    id: "agentrt1",
    name: "AgentRouter",
    baseURL: "https://agentrouter.org/v1",
    modelId: "glm-5.1",
    contextLimit: 128000,
  };

  it("loads custom endpoint keys from keychain and mirrors them into chat state", async () => {
    const load = vi.fn(async () => ({ agentrt1: "secret" }));
    const set = vi.fn();

    await hydrateCustomEndpointKeys([endpoint], load, set);

    expect(load).toHaveBeenCalledWith([endpoint]);
    expect(set).toHaveBeenCalledWith({ agentrt1: "secret" });
  });

  it("clears chat endpoint keys without touching keychain when there are no endpoints", async () => {
    const load = vi.fn();
    const set = vi.fn();

    await hydrateCustomEndpointKeys([], load, set);

    expect(load).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({});
  });
});
