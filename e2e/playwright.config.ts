import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./src/paths.js";

const patient = Boolean(process.env.CI || process.env.NEXESTRA_E2E_SLOW === "1");

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
  // A local failure should return immediately. CI retries once to distinguish
  // infrastructure flakes from deterministic regressions.
  retries: process.env.CI ? 1 : 0,

  /* Live provider tests are opt-in and may stream a full research/planning
     turn, so keep headroom above the fast credential-free acceptance suite. */
  timeout: patient ? 150_000 : 30_000,
  expect: { timeout: patient ? 15_000 : 5_000 },

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    video: "off",
    actionTimeout: patient ? 15_000 : 5_000,
    navigationTimeout: patient ? 30_000 : 10_000,
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
