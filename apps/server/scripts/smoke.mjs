/**
 * Does `pnpm start` actually start?
 *
 * `pnpm build` has never been able to answer that: esbuild is happy to
 * externalise a package nothing installs next to the bundle, and the failure
 * only shows up as `ERR_MODULE_NOT_FOUND` the first time somebody runs the
 * production server. So this script does the one thing the type checker, the
 * unit tests and Playwright all skip — it boots `dist/index.js` the way a user
 * would, on a scratch `NEXESTRA_HOME` and a free port, waits for
 * `/api/health`, and shuts it down again.
 *
 *     pnpm --filter @nexestra/server smoke      # assumes dist/ is current
 *     node scripts/smoke.mjs --build            # build first
 *
 * Exit code 0 means the production server is real.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = join(root, "dist", "index.js");

const READY_TIMEOUT_MS = 60_000;

if (process.argv.includes("--build")) {
  await run(process.execPath, [join(here, "build.mjs")], { cwd: root });
}

if (!existsSync(entry)) {
  fail(`${entry} is missing — run \`pnpm --filter @nexestra/server build\` first`);
}

const home = await mkdtemp(join(tmpdir(), "nexestra-smoke-"));
const port = await freePort();
let child;

try {
  child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NEXESTRA_HOME: home,
      NEXESTRA_HOST: "127.0.0.1",
      NEXESTRA_PORT: String(port),
      NEXESTRA_SEED_MOCK: "0",
      NEXESTRA_MASTER_LLM: "demo",
      NEXESTRA_DEV: "",
    },
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const exited = new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(`the server exited (code ${code}, signal ${signal})\n${output}`));
    });
  });

  const health = await Promise.race([waitForHealth(port), exited]);
  if (health.ok !== true) fail(`/api/health answered ${JSON.stringify(health)}\n${output}`);

  process.stdout.write(
    `  pnpm start smoke: ok — ${entry}\n` +
      `    version ${health.version}  master ${health.master?.client ?? "?"}  port ${port}\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (child?.pid) child.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
}

process.exit(0);

/* ------------------------------------------------------------------ helpers */

async function waitForHealth(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server never became healthy on 127.0.0.1:${port} (${last})`);
}

/** Ask the OS for a port nothing is using, then hand it to the server. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

function fail(message) {
  process.stderr.write(`  pnpm start smoke: FAILED\n    ${message}\n`);
  process.exit(1);
}
