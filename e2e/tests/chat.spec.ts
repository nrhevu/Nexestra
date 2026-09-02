/**
 * Credential-free production Chat behaviour. Global setup strips provider
 * credentials on purpose: the browser suite proves an unconfigured Master is
 * honest and durable instead of exercising a paid or simulated model.
 */
import { createFixture, type Fixture } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "chat");
});

test("reports that the Master provider needs configuration", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);

  const composer = page.getByPlaceholder("Message Master...");
  await composer.fill("research and plan a CLI todo app");
  await composer.press("Enter");

  await expect(
    page.locator(".msg__body").filter({ hasText: "research and plan a CLI todo app" }),
  ).toBeVisible();
  const error = page.locator(".card--error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("OPENAI_API_KEY");
  await expect(page.getByRole("region", { name: "Questions from Master" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Plan preview" })).toHaveCount(0);
});

test("keeps the failed turn's user transcript across a reload", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);

  const composer = page.getByPlaceholder("Message Master...");
  await composer.fill("tidy up the build script");
  await composer.press("Enter");
  await expect(page.locator(".card--error")).toBeVisible();

  await page.reload();
  await expect(page.locator(".msg--live")).toHaveCount(0);
  await expect(
    page.locator(".msg__body").filter({ hasText: "tidy up the build script" }),
  ).toBeVisible();
});
