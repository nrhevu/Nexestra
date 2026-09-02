import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./src/paths.js";

/**
 * One worker, no parallelism: every test drives the same server and the same
 * SQLite database, and the point of the suite is the real wiring rather than
 * throughput. Specs stay independent by creating their own workspace and
 * thread through the API.
 *
 * The server is started by `src/global-setup.ts` rather than by Playwright's
 * `webServer`, because it needs a scratch `NEXESTRA_HOME` and a throwaway git
 * repository created first.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  globalSetup: "./src/global-setup.ts",
  globalTeardown: "./src/global-teardown.ts",

  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,

  /* The demo Master streams its answers with a deliberate delay, so a full
     clarify → spec → approve → plan flow is a minute of wall clock. */
  timeout: 150_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
