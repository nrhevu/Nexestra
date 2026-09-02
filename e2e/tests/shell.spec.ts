/**
 * (a) The shell renders and the five surfaces are reachable — by mouse and by
 * keyboard. This is the M0 acceptance criterion, still true against the real
 * server (PLAN.md §8 M0).
 */
import type { Page } from "@playwright/test";
import { createFixture, type Fixture } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

const SURFACES = [
  { route: "chat", label: "Workspace / Chat", title: /^Chat — / },
  { route: "board", label: "Task Board", title: /^Task Board — / },
  { route: "agents", label: "Agents", title: /^Agents — / },
  { route: "editor", label: "Editor / Runs", title: /^Editor — / },
  { route: "memory", label: "Memory Graph", title: /^Memory Graph$/ },
] as const;

const surfaceTitle = (page: Page) => page.locator(".surface__title");

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "shell");
});

test("renders the shell chrome", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);

  await expect(page.getByText("Nexestra", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search and open command palette" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Workspaces" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();
  await expect(surfaceTitle(page)).toHaveText(`Chat — ${fixture.thread.title}`);
  await expect(page.getByRole("textbox", { name: /Message Master/ })).toBeVisible();
});

test("navigates the five surfaces from the navigation panel", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);

  for (const surface of SURFACES) {
    await page.locator(".nav__surfaces .nav__surface").filter({ hasText: surface.label }).click();
    await expect(page).toHaveURL(new RegExp(`/${surface.route}$`));
    await expect(surfaceTitle(page)).toHaveText(surface.title);
  }
});

test("switches surface with ⌘1..⌘5", async ({ page }) => {
  await page.goto(`${fixture.route}/chat`);
  await expect(surfaceTitle(page)).toHaveText(SURFACES[0].title);

  for (const [index, surface] of SURFACES.entries()) {
    await page.keyboard.press(`ControlOrMeta+${index + 1}`);
    await expect(page).toHaveURL(new RegExp(`/${surface.route}$`));
    await expect(surfaceTitle(page)).toHaveText(surface.title);
  }
});

test("survives a reload on a deep link", async ({ page }) => {
  await page.goto(`${fixture.route}/board`);
  await expect(surfaceTitle(page)).toHaveText(/^Task Board — /);

  await page.reload();
  await expect(surfaceTitle(page)).toHaveText(/^Task Board — /);
});
