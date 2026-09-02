/**
 * (c) The M2 → M3 flow, end to end against the real server on the
 * deterministic `DemoLlmClient`: a vague message becomes questions, the
 * answers become a spec, approving the spec produces a plan, and the plan
 * lands on the Task Board (PLAN.md §8 M2, M3).
 *
 * No `ANTHROPIC_API_KEY` is involved — global setup strips it — so this is the
 * flow a fresh checkout gets, and it is the same phase machine, tool
 * validation and store writes the live model goes through.
 */
import { createFixture, type Fixture } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "chat");
});

test("turns a vague message into questions, a spec, a plan and a board", async ({
  page,
  nexestra,
}) => {
  await page.goto(`${fixture.route}/chat`);

  await page.getByPlaceholder("Message Master...").fill("make me a CLI todo app");
  await page.getByPlaceholder("Message Master...").press("Enter");

  /* ---------------------------------------------------------- clarifying */

  const questions = page.getByRole("region", { name: "Questions from Master" });
  await expect(questions).toBeVisible({ timeout: 60_000 });

  const items = questions.locator(".qcard__item");
  await expect(items).toHaveCount(3);

  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    await items.nth(index).locator(".qcard__option").first().click();
  }
  await questions.getByRole("button", { name: "Submit answers" }).click();

  /* --------------------------------------------------------- spec_frozen */

  const spec = page.getByRole("region", { name: "Specification" });
  await expect(spec).toBeVisible({ timeout: 60_000 });
  await expect(spec).toContainText("Acceptance criteria (3)");
  await expect(spec).toContainText("make me a CLI todo app");

  const approval = page.getByRole("region", { name: "Approval required" });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("Freeze the spec");
  await approval.getByRole("button", { name: "Approve" }).click();

  /* ------------------------------------------------------------ planning */

  const plan = page.getByRole("region", { name: "Plan preview" });
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(plan).toContainText("Implement the change");

  const thread = await (await fetch(`${nexestra.baseURL}/api/threads/${fixture.thread.id}`)).json();
  expect(thread.phase).toBe("planning");

  /* --------------------------------------------------------------- board */

  await page.keyboard.press("ControlOrMeta+2");
  await expect(page).toHaveURL(/\/board$/);

  const cards = page.locator(".task-card__title");
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toHaveText("Survey the workspace and pin the approach");
  await expect(page.locator(".task-card__deps").first()).toContainText("blocked by");
});

test("keeps the transcript across a reload", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);

  await page.getByPlaceholder("Message Master...").fill("tidy up the build script");
  await page.getByPlaceholder("Message Master...").press("Enter");

  await expect(page.getByRole("region", { name: "Questions from Master" })).toBeVisible({
    timeout: 60_000,
  });

  await page.reload();
  await expect(page.locator(".msg--live")).toHaveCount(0);
  await expect(
    page.locator(".msg__body").filter({ hasText: "tidy up the build script" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Questions from Master" })).toBeVisible();
});
