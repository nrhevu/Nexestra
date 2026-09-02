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

  const openai = page
    .locator(".provider-card")
    .filter({ has: page.getByText("OpenAI", { exact: true }) });
  await openai.getByLabel("API key", { exact: true }).fill("e2e-provider-secret");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(openai.getByText("credential saved")).toBeVisible();
  await expect(page.locator(".provider-status")).toContainText("ready");
  await expect(openai.getByLabel("API key", { exact: true })).toHaveValue("");

  await openai.getByRole("button", { name: "Remove saved key" }).click();
  await expect(openai.getByText("credential missing")).toBeVisible();
  await expect(page.locator(".provider-status")).toContainText("configuration required");
});

test("adds and activates a custom provider through the connection dialog", async ({ page }) => {
  await page.goto("/settings");

  const providerId = `e2e-provider-${Date.now()}`;
  const providerName = `E2E Provider ${Date.now()}`;
  await page.getByRole("button", { name: "Add custom provider" }).click();

  const dialog = page.getByRole("dialog", { name: "Add custom provider" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Provider ID").fill(providerId);
  await dialog.getByLabel("Display name").fill(providerName);
  await dialog.getByLabel("Base URL").fill("https://models.example/v1");
  await dialog.getByLabel("API key", { exact: true }).fill("e2e-custom-secret");
  await dialog.getByLabel("Model ID").fill("planning-model");
  await dialog.getByRole("button", { name: "Add provider" }).click();

  await expect(dialog).not.toBeVisible();
  const provider = page
    .locator(".provider-card")
    .filter({ has: page.getByText(providerName, { exact: true }) });
  await expect(provider).toContainText("Active");
  await expect(provider).toContainText("credential saved");
  await expect(page.locator(".provider-status")).toContainText(providerName);
  await expect(page.locator(".provider-status")).toContainText("ready");

  await provider.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(provider).toHaveCount(0);
});

test("is reachable with ⌘, and saves a changed default", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);
  await expect(page.locator(".surface__title")).toHaveText(/^Chat — /);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page).toHaveURL(/\/settings$/);

  const concurrency = page.getByLabel("Concurrency (1–8)");
  await concurrency.fill("4");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("saved")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Concurrency (1–8)")).toHaveValue("4");
});
