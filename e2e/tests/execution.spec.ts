/**
 * (f) Executing a task with the fake harness — the M4 → M6 flow.
 *
 * SKIPPED until `apps/server` reads `NEXESTRA_FAKE_HARNESS` and registers
 * `@nexestra/adapter-fake` with the orchestrator. Global setup greps the
 * server sources for that variable and records the answer, so these specs turn
 * themselves on the moment the switch lands — nothing here has to be edited to
 * enable them.
 *
 * TODO(M6): two things are still missing when the switch arrives.
 *   1. A trigger. There is no `POST /api/tasks/:id/dispatch`, and the
 *      `DemoLlmClient` has no `executing` phase, so nothing can start a run
 *      from a test yet. `startExecution()` below is the single place to point
 *      at whatever M6 exposes (an HTTP route, or a demo-model turn that calls
 *      `dispatch_task`).
 *   2. Real Editor data. `/api/files`, `/api/files/content` and `/api/terminal`
 *      are still the `@nexestra/core/mock` fixtures (`routes/placeholders.ts`),
 *      so the assertions about the worktree below only mean something once the
 *      Editor surface reads the run's worktree.
 *
 * What the flow should prove, end to end and with no real harness installed:
 * a task goes `todo → running → done`, the Editor shows the files the fake
 * wrote and the terminal output of its run, and a `permission_request` from
 * the harness surfaces in the approval queue and unblocks the run when it is
 * approved.
 */
import type { Page } from "@playwright/test";
import { createFixture, createTask, type Fixture, listTasks } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  test.skip(
    !nexestra.fakeHarnessSupported,
    "apps/server does not read NEXESTRA_FAKE_HARNESS yet — the orchestrator wiring is M6",
  );
  // Second gate: even with the switch in place these need a way to dispatch a
  // task (see `startExecution`). Opt in with NEXESTRA_E2E_EXECUTION=1 once it
  // exists, then delete this line.
  test.skip(
    process.env.NEXESTRA_E2E_EXECUTION !== "1",
    "set NEXESTRA_E2E_EXECUTION=1 once there is a way to dispatch a task from a test (M6)",
  );
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "execution");
});

/**
 * Start the task running.
 *
 * TODO(M6): replace with the real trigger. Until then this throws, which is
 * why every spec in this file is gated on `fakeHarnessSupported`.
 */
async function startExecution(_page: Page, _taskId: string): Promise<void> {
  throw new Error("no way to dispatch a task from a test yet — wire this to the M6 dispatch route");
}

test("runs a task to done with the fake harness", async ({ page, nexestra }) => {
  const task = await createTask(nexestra.baseURL, {
    threadId: fixture.thread.id,
    title: "Add a hello module",
    // The fake harness reads its scenario and its files out of the instructions.
    description: "Create `src/hello.ts`. [scenario: success]",
    assignedHarness: "codex",
    status: "ready",
  });

  await page.goto(`${fixture.route}/board`);
  await startExecution(page, task.id);

  const done = page.locator(".column").filter({ has: page.getByText("DONE", { exact: true }) });
  await expect(done).toContainText("Add a hello module", { timeout: 120_000 });

  const tasks = await listTasks(nexestra.baseURL, fixture.thread.id);
  expect(tasks.find((row) => row.id === task.id)?.status).toBe("done");
});

test("shows the files and the terminal output of the run in the Editor", async ({
  page,
  nexestra,
}) => {
  const task = await createTask(nexestra.baseURL, {
    threadId: fixture.thread.id,
    title: "Add a hello module",
    description: "Create `src/hello.ts`. [scenario: success]",
    assignedHarness: "codex",
    status: "ready",
  });

  await page.goto(`${fixture.route}/editor`);
  await startExecution(page, task.id);

  await expect(page.locator(".surface__title")).toHaveText(/^Editor — /);
  // The fake writes the file the instructions name, so the worktree really has it.
  await expect(page.getByText("hello.ts")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".terminal, .xterm")).toBeVisible();
});

test("surfaces a harness permission request in the approval queue", async ({ page, nexestra }) => {
  const task = await createTask(nexestra.baseURL, {
    threadId: fixture.thread.id,
    title: "Write outside the sandbox",
    description: "Create `src/hello.ts`. [scenario: permission_request]",
    assignedHarness: "codex",
    status: "ready",
  });

  await page.goto(`${fixture.route}/chat`);
  await startExecution(page, task.id);

  const approval = page.getByRole("region", { name: "Approval required" });
  await expect(approval).toBeVisible({ timeout: 120_000 });
  await approval.getByRole("button", { name: "Approve" }).click();

  const done = page.locator(".column").filter({ has: page.getByText("DONE", { exact: true }) });
  await page.keyboard.press("ControlOrMeta+2");
  await expect(done).toContainText("Write outside the sandbox", { timeout: 120_000 });
});
