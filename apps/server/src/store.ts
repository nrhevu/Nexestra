import { createStore, type NexestraStore, seedMock } from "@nexestra/storage";
import { SEED_MOCK } from "./config.js";

export interface OpenServerStoreResult {
  store: NexestraStore;
  seeded: boolean;
}

/**
 * Open the store the server runs on and, when asked, load the demo content.
 *
 * Seeding is requested with `NEXESTRA_SEED_MOCK=1` or `--seed-mock`, and is a
 * no-op once the database already has a workspace.
 */
export function openServerStore(): OpenServerStoreResult {
  const store = createStore();
  const seeded = SEED_MOCK ? seedMock(store) : false;
  return { store, seeded };
}
