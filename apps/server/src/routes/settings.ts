import { AppSettingsSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body } from "../errors.js";

/** Machine-wide defaults edited from the Settings surface. */
export function settingsRoutes(store: NexestraStore) {
  return new Hono()
    .get("/", (c) => c.json(store.getSettings()))
    .put("/", async (c) => c.json(store.putSettings(await body(c, AppSettingsSchema.partial()))));
}
