/**
 * Production execution shell. Live harness runs are opt-in because they need a
 * logged-in Codex or OpenCode CLI, but the task hand-off surface must still be
 * honest and usable on a machine with neither installed.
 */
import { createFixture, createTask, type Fixture } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "execution");
});

test("shows a real harness task without exposing a fake adapter", async ({ page, nexestra }) => {
  await createTask(nexestra.baseURL, {
    threadId: fixture.thread.id,
    title: "Implement the approved plan",
    description: "Use the project spec and verification criteria recorded by Master.",
    assignedHarness: "codex",
    status: "ready",
  });

  const response = await fetch(`${nexestra.baseURL}/api/harnesses`);
  expect(response.ok).toBe(true);
  const harnesses = (await response.json()) as Array<{ id: string }>;
  expect(harnesses.map((harness) => harness.id)).toEqual(["codex", "opencode"]);

  await page.goto(`${fixture.route}/board`);
  await expect(page.getByText("Implement the approved plan")).toBeVisible();
  await expect(page.getByTestId("execution-start")).toBeVisible();
  await expect(page.getByTestId("execution-state")).toContainText("idle");
});
