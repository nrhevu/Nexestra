/**
 * (d) Dragging a card between columns writes through to the server, and the
 * move survives a reload — the M3 acceptance criterion (PLAN.md §8 M3).
 */
import type { Locator, Page } from "@playwright/test";
import { createFixture, createTask, type Fixture, listTasks } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

const column = (page: Page, label: string): Locator =>
  page.locator(".column").filter({ has: page.getByText(label, { exact: true }) });

/**
 * `@dnd-kit`'s `PointerSensor` only starts a drag after 4px of movement, so a
 * single `mouse.move` to the target would be read as a click. Nudge, then
 * travel in steps so the droppable under the pointer is recomputed.
 */
async function dragCardTo(page: Page, card: Locator, target: Locator): Promise<void> {
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("could not measure the card or the target column");

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "board");
  for (const title of ["Write the parser", "Cover it with tests", "Document it"]) {
    await createTask(nexestra.baseURL, {
      threadId: fixture.thread.id,
      title,
      assignedHarness: "codex",
      status: "todo",
    });
  }
});

test("drags a card into IN PROGRESS and keeps it there across a reload", async ({
  page,
  nexestra,
}) => {
  await page.goto(`${fixture.route}/board`);

  const todo = column(page, "TODO");
  const inProgress = column(page, "IN PROGRESS");
  await expect(todo.locator(".task-card")).toHaveCount(3);
  await expect(inProgress.locator(".task-card")).toHaveCount(0);

  const card = todo.locator(".task-card").filter({ hasText: "Write the parser" });
  const written = page.waitForResponse(
    (response) => /\/api\/tasks\/.+\/status$/.test(response.url()) && response.ok(),
  );
  await dragCardTo(page, card, inProgress);
  await written;

  await expect(inProgress.locator(".task-card")).toHaveCount(1);
  await expect(inProgress).toContainText("Write the parser");
  await expect(todo.locator(".task-card")).toHaveCount(2);

  // The server, not just the cache.
  const tasks = await listTasks(nexestra.baseURL, fixture.thread.id);
  expect(tasks.find((task) => task.title === "Write the parser")?.status).toBe("running");

  await page.reload();
  await expect(column(page, "IN PROGRESS")).toContainText("Write the parser");
  await expect(column(page, "TODO").locator(".task-card")).toHaveCount(2);
});

test("selects a card and loads it into the details sidebar", async ({ page }) => {
  await page.goto(`${fixture.route}/board`);

  const card = page.locator(".task-card").filter({ hasText: "Document it" });
  await card.click();

  await expect(card).toHaveClass(/task-card--selected/);
  await expect(page.locator(".sidebar input").first()).toHaveValue("Document it");
});
