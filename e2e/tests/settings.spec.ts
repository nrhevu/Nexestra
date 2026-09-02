/**
 * (e) Settings tells the truth about what the process actually started with:
 * which model client the Master is on, whether an API key was saved, and which
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

  // The suite starts without provider credentials. Production must say
  // it is unconfigured instead of silently falling back to a demo model.
  const master = page.locator(".provider-status");
  await expect(master).toContainText("configuration required");
  await expect(master).toContainText("OpenAI");
  await expect(master).toContainText("chat-latest");
  await expect(master).toContainText("missing");
  await expect(page.getByText(/Enter provider credentials here/)).toBeVisible();

  // Harness detection table.
  await expect(page.getByRole("heading", { name: "Detected harnesses" })).toBeVisible();
  const harnesses = page.locator("table.nx-table");
  await expect(harnesses).toBeVisible();
  await expect(harnesses.locator("th").first()).toHaveText("harness");
  await expect(harnesses).toContainText("codex");
  await expect(harnesses).not.toContainText("fake");
});

test("saves and removes an API key from the provider form", async ({ page }) => {
  await page.goto("/settings");

  const openai = page.locator(".provider-card").filter({ hasText: "OpenAI" });
  await openai.getByLabel("API key").fill("e2e-provider-secret");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(openai.getByText("credential saved")).toBeVisible();
  await expect(page.locator(".provider-status")).toContainText("ready");
  await expect(openai.getByLabel("API key")).toHaveValue("");

  await openai.getByRole("button", { name: "Remove saved key" }).click();
  await expect(openai.getByText("credential missing")).toBeVisible();
  await expect(page.locator(".provider-status")).toContainText("configuration required");
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
