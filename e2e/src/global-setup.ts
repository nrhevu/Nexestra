/**
 * Everything the suite needs before the first test opens a page:
 *
 * 1. a scratch `NEXESTRA_HOME` and a throwaway git repository;
 * 2. a Nexestra server on `NEXESTRA_E2E_PORT` (4282) with an empty database,
 *    the demo Master and the fake harness switch set;
 * 3. a state file the workers read to find all of the above.
 *
 * It also records whether `apps/server` reads `NEXESTRA_FAKE_HARNESS` yet. The
 * execution specs (M6) skip themselves when it does not, so the suite stays
 * green on a branch where the orchestrator is not wired in — and starts
 * running them the moment it is, with no edit here.
 */
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo } from "@nexestra/core/testing";
import { SERVER_DIR } from "./paths.js";
import { startServer } from "./server.js";
import { writeE2eState } from "./state.js";

const FAKE_HARNESS_ENV = "NEXESTRA_FAKE_HARNESS";

export default async function globalSetup(): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "nexestra-e2e-"));
  const home = path.join(scratch, "home");
  await mkdir(home, { recursive: true });

  const repo = await createTempGitRepo({
    prefix: "nexestra-e2e-repo-",
    files: {
      "README.md": "# e2e scratch repository\n\nCreated by @nexestra/e2e.\n",
      "src/index.ts": "export const hello = 'world';\n",
      "package.json": `${JSON.stringify({ name: "e2e-scratch", version: "0.0.0", private: true }, null, 2)}\n`,
    },
  });
  await repo.commitAll("scratch fixture");

  const logFile = path.join(scratch, "server.log");
  const fakeHarnessSupported = await serverReadsFakeHarnessSwitch();

  const server = await startServer({ home, logFile });

  writeE2eState({
    baseURL: server.baseURL,
    home,
    repo: repo.repo,
    repoRoot: repo.root,
    logFile,
    pid: server.pid,
    fakeHarnessSupported,
  });

  process.stdout.write(
    `\n  e2e server   ${server.baseURL}\n` +
      `  home         ${home}\n` +
      `  repo         ${repo.repo}\n` +
      `  server log   ${logFile}\n` +
      `  ${FAKE_HARNESS_ENV}  ${fakeHarnessSupported ? "honoured by apps/server" : "not read yet — execution specs will skip (M6)"}\n\n`,
  );
}

/**
 * Does this checkout of `apps/server` know about the fake harness switch?
 *
 * Grepping the source is blunt, but it is the only honest signal: the server
 * exposes nothing over HTTP that says which adapters the orchestrator was
 * given, and guessing from `/api/harnesses` would be worse.
 */
async function serverReadsFakeHarnessSwitch(): Promise<boolean> {
  const files = await walk(path.join(SERVER_DIR, "src"));
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    if ((await readFile(file, "utf8")).includes(FAKE_HARNESS_ENV)) return true;
  }
  return false;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(full);
  }
  return found;
}
