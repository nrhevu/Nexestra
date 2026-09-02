import { CreateWorkspaceRequestSchema, UpdateWorkspaceRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, required } from "../errors.js";
import { resolveWorkspacePath } from "../workspace-path.js";

export function workspaceRoutes(store: NexestraStore) {
  return new Hono()
    .get("/", (c) => c.json(store.listWorkspaces()))

    .post("/", async (c) => {
      const input = await body(c, CreateWorkspaceRequestSchema);
      const resolved = resolveWorkspacePath(input.path);
      const settings = store.getSettings();

      const workspace = store.createWorkspace({
        name: input.name ?? resolved.name,
        rootPath: resolved.rootPath,
        shortLabel: input.shortLabel,
        defaultBranch: input.defaultBranch ?? resolved.defaultBranch,
        settings: {
          defaultHarness: settings.defaultHarness,
          // Empty means "let the harness choose"; carrying it onto the
          // workspace as `""` would look like an explicit, impossible model.
          ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
          defaultSandbox: settings.defaultSandbox,
          concurrency: settings.concurrency,
          budgetUSD: settings.budgetUSD,
          ...input.settings,
        },
      });
      return c.json(workspace, 201);
    })

    .get("/:workspaceId", (c) =>
      c.json(required(store.getWorkspace(c.req.param("workspaceId")), "workspace")),
    )

    .patch("/:workspaceId", async (c) => {
      const id = c.req.param("workspaceId");
      required(store.getWorkspace(id), "workspace");
      const patch = await body(c, UpdateWorkspaceRequestSchema);
      return c.json(store.updateWorkspace(id, patch));
    });
}
