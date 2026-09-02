/**
 * Stop the server and delete everything global setup created.
 *
 * `NEXESTRA_E2E_KEEP=1` leaves the scratch home, the repository and the server
 * log in place, which is what you want when a failure needs an autopsy.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { stopServer } from "./server.js";
import { clearE2eState, readE2eState } from "./state.js";

export default async function globalTeardown(): Promise<void> {
  let state: ReturnType<typeof readE2eState>;
  try {
    state = readE2eState();
  } catch {
    return; // Setup never got far enough to leave anything behind.
  }

  await stopServer(state.pid);

  if (process.env.NEXESTRA_E2E_KEEP === "1") {
    process.stdout.write(`\n  kept ${path.dirname(state.home)} and ${state.repoRoot}\n`);
    return;
  }

  await rm(path.dirname(state.home), { recursive: true, force: true });
  await rm(state.repoRoot, { recursive: true, force: true });
  clearE2eState();
}
