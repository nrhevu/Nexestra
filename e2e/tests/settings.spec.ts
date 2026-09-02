/**
 * (e) Settings tells the truth about what the process actually started with:
 * which model client the Master is on, whether an API key was found, and which
 * harnesses were detected (PLAN.md §8 M7).
 */
import { createFixture, type Fixture } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "settings");
});

test("reports the demo Master and the detected harnesses", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Nexestra — local settings" })).toBeVisible();

  // The suite runs with no ANTHROPIC_API_KEY, so the Master must say so.
  const master = page.locator(".kv").first();
  await expect(master).toContainText("demo");
  await expect(master).toContainText("nexestra-demo-master");
  await expect(master).toContainText("not set");
  await expect(page.getByText("No ANTHROPIC_API_KEY on the server")).toBeVisible();

  // Harness detection table.
  await expect(page.getByRole("heading", { name: "Detected harnesses" })).toBeVisible();
  const harnesses = page.locator("table.nx-table");
  await expect(harnesses).toBeVisible();
  await expect(harnesses.locator("th").first()).toHaveText("harness");
  await expect(harnesses).toContainText("codex");
});

test("is reachable with ⌘, and saves a changed default", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page).toHaveURL(/\/settings$/);

  const concurrency = page.getByLabel("Concurrency (1–8)");
  await concurrency.fill("4");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Concurrency (1–8)")).toHaveValue("4");
});
