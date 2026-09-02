/**
 * The `test` every spec imports: Playwright's, plus what global setup left
 * behind: the base URL, scratch home and throwaway repository.
 */
import { test as base, expect } from "@playwright/test";
import type { E2eState } from "./state.js";
import { readE2eState } from "./state.js";

export interface NexestraFixtures {
  /** Everything `src/global-setup.ts` recorded for this run. */
  nexestra: E2eState;
}

export const test = base.extend<NexestraFixtures>({
  // `baseURL` comes from the config and wins, so a spec that talks to the API
  // directly and a page navigation can never disagree about where the server is.
  nexestra: async ({ baseURL }, use) => {
    const state = readE2eState();
    await use(baseURL ? { ...state, baseURL } : state);
  },
});

export { expect };
