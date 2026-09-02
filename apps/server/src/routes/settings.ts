import type { AppSettingsResponse } from "@nexestra/core";
import { AppSettingsSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body } from "../errors.js";
import type { MasterRunner } from "../master/runner.js";

/**
 * Machine-wide defaults edited from the Settings surface.
 *
 * The response also carries `master`: which model client the process actually
 * started with, and whether an API key was found. It rides along here rather
 * than on its own route so the surface can render the truth in one request —
 * and it is read-only, because swapping the model client means restarting the
 * server, not writing a row.
 */
export function settingsRoutes(store: NexestraStore, runner: MasterRunner) {
  const respond = (settings: ReturnType<NexestraStore["getSettings"]>): AppSettingsResponse => ({
    ...settings,
    master: runner.runtime,
  });

  return new Hono()
    .get("/", (c) => c.json(respond(store.getSettings())))
    .put("/", async (c) =>
      c.json(respond(store.putSettings(await body(c, AppSettingsSchema.partial())))),
    );
}
