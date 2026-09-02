import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Context } from "hono";
import { WEB_DIST } from "./config.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function readable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toWebStream(path: string): ReadableStream<Uint8Array> {
  const stream = createReadStream(path);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
    },
    cancel() {
      stream.destroy();
    },
  });
}

/**
 * Serve `apps/web/dist` for production builds, falling back to `index.html`
 * so client-side routes (`/w/:id/t/:id/board`) reload correctly.
 */
export async function serveWebDist(c: Context): Promise<Response> {
  const requested = decodeURIComponent(new URL(c.req.url).pathname);
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(join(WEB_DIST, safe));

  const inside = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep);
  const target = inside && (await readable(candidate)) ? candidate : join(WEB_DIST, "index.html");

  if (!(await readable(target))) {
    return c.text("web build not found — run `pnpm --filter @nexestra/web build`", 404);
  }

  const type = MIME[extname(target)] ?? "application/octet-stream";
  return new Response(toWebStream(target), {
    headers: {
      "content-type": type,
      "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000",
    },
  });
}
