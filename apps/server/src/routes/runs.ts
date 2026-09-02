import { RunControlRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, body, conflict, required, requireQuery } from "../errors.js";
import { readWorktreeDiff, readWorktreeFile, readWorktreeTree } from "../execution/files.js";
import type { ExecutionRuntime } from "../execution/runtime.js";

/**
 * Runs are written by the orchestrator, never by HTTP — so everything here is
 * a read, except `control`, which forwards a `RunControl` to the adapter that
 * owns the live process.
 *
 * The three worktree routes are what makes the Editor surface real: the file
 * tree, one file's text, and the unified diff against the branch the worktree
 * was cut from. Run *events* need no route of their own — they already stream
 * over `/ws` as `run.event_appended` and the whole log is on
 * `GET /api/runs/:id/events`.
 */
export function runRoutes(store: NexestraStore, execution: ExecutionRuntime) {
  const run = (id: string) => required(store.getRun(id), "run");

  const worktreeOf = (runId: string): string => {
    const row = run(runId);
    if (!row.worktreePath) {
      throw conflict(`run ${runId} has no worktree yet`, { runId, status: row.status });
    }
    return row.worktreePath;
  };

  return (
    new Hono()
      .get("/", (c) => {
        const threadId = requireQuery(c, "threadId");
        required(store.getThread(threadId), "thread");
        return c.json(store.listRuns(threadId));
      })

      .get("/:runId", (c) => c.json(run(c.req.param("runId"))))

      .get("/:runId/events", (c) => {
        const runId = c.req.param("runId");
        run(runId);
        const after = c.req.query("afterSeq");
        return c.json(
          store.listRunEvents(runId, after === undefined ? undefined : Number.parseInt(after, 10)),
        );
      })

      /** Cancel / steer / answer a permission prompt on a live run. */
      .post("/:runId/control", async (c) => {
        const runId = c.req.param("runId");
        run(runId);
        const input = await body(c, RunControlRequestSchema);

        if (input.action === "answer_permission") {
          const result = await execution.answerPermission(runId, input);
          return c.json({ runId, ...result });
        }

        const result = await execution.orchestrator.controlRun(runId, {
          action: input.action,
          ...("message" in input && input.message ? { message: input.message } : {}),
        });
        return c.json({ runId, ...result });
      })

      /* ---------------------------------------------------------- the worktree */

      .get("/:runId/files", async (c) =>
        c.json(await readWorktreeTree(worktreeOf(c.req.param("runId")))),
      )

      .get("/:runId/files/content", async (c) => {
        const runId = c.req.param("runId");
        const relative = requireQuery(c, "path");
        const file = await readWorktreeFile(worktreeOf(runId), relative);
        if (!file) throw badRequest(`"${relative}" is not a readable file in this worktree`);
        return c.json(file);
      })

      .get("/:runId/diff", async (c) => {
        const runId = c.req.param("runId");
        const row = run(runId);
        const thread = store.getThread(row.threadId);
        const workspace = thread ? store.getWorkspace(thread.workspaceId) : null;
        return c.json(
          await readWorktreeDiff({
            runId,
            worktree: worktreeOf(runId),
            ...(workspace?.defaultBranch ? { base: workspace.defaultBranch } : {}),
          }),
        );
      })
  );
}
