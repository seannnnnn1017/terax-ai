import type { CustomEndpoint } from "../config";
import type { CustomEndpointKeys } from "./keyring";

export async function hydrateCustomEndpointKeys(
  endpoints: readonly CustomEndpoint[],
  load: (
    endpoints: readonly CustomEndpoint[],
  ) => Promise<CustomEndpointKeys>,
  setKeys: (keys: CustomEndpointKeys) => void,
): Promise<void> {
  if (endpoints.length === 0) {
    setKeys({});
    return;
  }
  setKeys(await load(endpoints));
}
