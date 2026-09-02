import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * React Testing Library only auto-cleans when Vitest's globals are on, and they
 * are not: the repo imports `describe`/`it`/`expect` explicitly. Unmounting
 * here keeps one test's DOM out of the next one's queries.
 */
afterEach(() => {
  cleanup();
});
