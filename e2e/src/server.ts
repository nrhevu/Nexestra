/**
 * Starting and stopping the Nexestra server the e2e suite drives.
 *
 * Three things make this run reproducible:
 *
 * - a scratch `NEXESTRA_HOME`, so the suite never touches `~/.nexestra`;
 * - no provider credentials, so the database starts empty and Master reports
 *   its honest unconfigured state;
 * - `apps/web/dist` served by the server itself, so no Vite is involved and a
 *   test is looking at exactly what `pnpm build` produces.
 *
 * Since M7 the suite runs `apps/server/dist/index.js` — the same bundle
 * `pnpm start` runs — rather than the sources under `tsx`. That was impossible
 * before: the bundle externalised `better-sqlite3` and `drizzle-orm` without
 * declaring them, so it could not boot at all. Now that it can, running it here
 * means every e2e run is also a check that the production artefact works.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";
import { E2E_PORT, SERVER_DIR, WEB_DIST } from "./paths.js";

export interface StartServerOptions {
  readonly home: string;
  readonly logFile: string;
  /** Extra environment for the server process. */
  readonly env?: Record<string, string>;
  /** How long to wait for `/api/health`. */
  readonly timeoutMs?: number;
}

export interface RunningServer {
  readonly process: ChildProcess;
  readonly pid: number;
  readonly baseURL: string;
}

/** The production bundle — the exact file `pnpm start` runs. */
const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "index.js");

export function assertWebBuild(): void {
  if (existsSync(path.join(WEB_DIST, "index.html"))) return;
  throw new Error(
    `apps/web/dist is missing — run \`pnpm build\` before the e2e suite (looked in ${WEB_DIST})`,
  );
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  assertWebBuild();
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} is missing — run \`pnpm build\` before the e2e suite (\`pnpm e2e\` does)`,
    );
  }

  const log = openSync(options.logFile, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXESTRA_HOME: options.home,
    NEXESTRA_HOST: "127.0.0.1",
    NEXESTRA_PORT: String(E2E_PORT),
    ...options.env,
  };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "NEXESTRA_DEV",
    "NEXESTRA_WEB_DEV_URL",
  ]) {
    delete env[key];
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", log, log],
    // Its own process group, so teardown can take the whole tree down.
    detached: true,
  });
  child.unref();

  const baseURL = `http://127.0.0.1:${E2E_PORT}`;
  await waitForHealth(baseURL, options.timeoutMs ?? 60_000, child);

  return { process: child, pid: child.pid ?? 0, baseURL };
}

async function waitForHealth(
  baseURL: string,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the Nexestra server exited with code ${child.exitCode} before it was ready`);
    }
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) {
        const health = (await response.json()) as { ok?: boolean };
        if (health.ok) return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`the Nexestra server never became healthy on ${baseURL} (${lastError})`);
}

/** Take down the server and everything it spawned, politely then not. */
export async function stopServer(pid: number): Promise<void> {
  if (!pid) return;

  signalTree(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (alive(pid)) signalTree(pid, "SIGKILL");
}

/** Signal the whole process group, falling back to the process itself. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
