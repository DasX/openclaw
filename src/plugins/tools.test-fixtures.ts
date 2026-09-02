import { getPluginToolDescriptorCacheState } from "./tool-descriptor-cache.js";

export function resetPluginToolDescriptorCacheForTest(): void {
  const state = getPluginToolDescriptorCacheState();
  state.descriptors.clear();
  state.objectIds = new WeakMap();
  state.nextObjectId = 1;
}
