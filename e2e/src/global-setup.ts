/**
 * Everything the suite needs before the first test opens a page:
 *
 * 1. a scratch `NEXESTRA_HOME` and a throwaway git repository;
 * 2. a Nexestra server on `NEXESTRA_E2E_PORT` (4282) with an empty database
 *    and no provider credentials;
 * 3. a state file the workers read to find all of the above.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTempGitRepo } from "@nexestra/core/testing";
import { startServer } from "./server.js";
import { writeE2eState } from "./state.js";

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
  const server = await startServer({ home, logFile });

  writeE2eState({
    baseURL: server.baseURL,
    home,
    repo: repo.repo,
    repoRoot: repo.root,
    logFile,
    pid: server.pid,
  });

  process.stdout.write(
    `\n  e2e server   ${server.baseURL}\n` +
      `  home         ${home}\n` +
      `  repo         ${repo.repo}\n` +
      `  server log   ${logFile}\n\n`,
  );
}
