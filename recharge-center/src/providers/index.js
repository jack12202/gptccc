import { normalizeProvider } from "../utils.js";
import { ayanAdapter } from "./ayan-adapter.js";
import { sangeAdapter } from "./sange-adapter.js";

export const providerAdapters = {
  sange: sangeAdapter,
  ayan: ayanAdapter
};

export function getProviderAdapter(provider) {
  return providerAdapters[normalizeProvider(provider)];
}

export function listProviders() {
  return Object.values(providerAdapters).map(adapter => ({
    key: adapter.key,
    label: adapter.label
  }));
}
