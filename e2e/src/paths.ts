/** Where things live, relative to this package. Shared by setup and tests. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** `<repo>/e2e`. */
export const E2E_ROOT = path.resolve(here, "..");
/** The monorepo root. */
export const REPO_ROOT = path.resolve(E2E_ROOT, "..");
export const SERVER_DIR = path.join(REPO_ROOT, "apps", "server");
export const WEB_DIST = path.join(REPO_ROOT, "apps", "web", "dist");

/**
 * A free port, away from the dev server's 4242 and Vite's 5173, so an e2e run
 * never fights with a Nexestra the developer already has open.
 */
export const E2E_PORT = Number.parseInt(process.env.NEXESTRA_E2E_PORT ?? "4282", 10);
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/** Handover file between global setup, the workers and global teardown. */
export const STATE_FILE = path.join(E2E_ROOT, ".e2e-state.json");
