import { createStore, type NexestraStore } from "@nexestra/storage";

export interface OpenServerStoreResult {
  store: NexestraStore;
}

/** Open the production store. Test fixtures are injected by tests, never startup flags. */
export function openServerStore(): OpenServerStoreResult {
  const store = createStore();
  return { store };
}
