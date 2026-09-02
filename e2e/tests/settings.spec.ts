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

test("reports honest provider readiness and the detected harnesses", async ({ page }) => {
  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Nexestra — local settings" })).toBeVisible();

  // The suite deliberately removes provider credentials. Production must say
  // it is unconfigured instead of silently falling back to a demo model.
  const master = page.locator(".provider-status");
  await expect(master).toContainText("configuration required");
  await expect(master).toContainText("OpenAI");
  await expect(master).toContainText("chat-latest");
  await expect(master).toContainText("missing");
  await expect(page.getByText(/ChatGPT subscription OAuth is not exposed/)).toBeVisible();

  // Harness detection table.
  await expect(page.getByRole("heading", { name: "Detected harnesses" })).toBeVisible();
  const harnesses = page.locator("table.nx-table");
  await expect(harnesses).toBeVisible();
  await expect(harnesses.locator("th").first()).toHaveText("harness");
  await expect(harnesses).toContainText("codex");
  await expect(harnesses).not.toContainText("fake");
});

test("is reachable with ⌘, and saves a changed default", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);
  await expect(page.locator(".surface__title")).toHaveText(/^Chat — /);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page).toHaveURL(/\/settings$/);

  const concurrency = page.getByLabel("Concurrency (1–8)");
  await concurrency.fill("4");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Concurrency (1–8)")).toHaveValue("4");
});
