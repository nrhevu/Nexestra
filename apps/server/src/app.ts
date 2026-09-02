import type { HealthResponse } from "@nexestra/core";
import { Hono } from "hono";
import { hasWebBuild, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { mockRoutes } from "./routes/mock.js";
import { serveWebDist } from "./static.js";

export function createApp() {
  const api = new Hono()
    .get("/health", (c) => {
      const body: HealthResponse = { ok: true, version: SERVER_VERSION };
      return c.json(body);
    })
    .route("/mock", mockRoutes);

  const app = new Hono().route("/api", api);

  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    // In production the SPA is served from apps/web/dist; in dev it lives on
    // the Vite server, so bounce the browser there.
    if (hasWebBuild()) return serveWebDist(c);
    return c.redirect(`${WEB_DEV_URL}${c.req.path}`, 302);
  });

  return app;
}
