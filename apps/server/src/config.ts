import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of this module (works for both `src/` under tsx and `dist/`). */
const here = dirname(fileURLToPath(import.meta.url));

export const SERVER_VERSION = "0.0.0-m1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Local-first and unauthenticated means the bind address must stay loopback. */
export function resolveHost(value: string | undefined = process.env.NEXESTRA_HOST): string {
  const host = value?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `NEXESTRA_HOST must be a loopback host (${[...LOOPBACK_HOSTS].join(", ")}); received ${host}`,
    );
  }
  return host;
}

export const HOST = resolveHost();

export const PORT = Number.parseInt(process.env.NEXESTRA_PORT ?? "4242", 10);

/** Where `pnpm --filter @nexestra/web build` puts the SPA. */
export const WEB_DIST = resolve(here, "../../web/dist");

/** Vite dev server; non-API requests are redirected here while in dev mode. */
export const WEB_DEV_URL = process.env.NEXESTRA_WEB_DEV_URL ?? "http://localhost:5173";

/** Set by `pnpm --filter @nexestra/server dev`; forces the redirect-to-Vite path. */
export const DEV_MODE = process.env.NEXESTRA_DEV === "1";

/**
 * Serve `apps/web/dist` only in production. In dev the SPA lives on the Vite
 * server, so a stale `dist/` must never shadow it.
 */
export function hasWebBuild(): boolean {
  return !DEV_MODE && existsSync(resolve(WEB_DIST, "index.html"));
}
