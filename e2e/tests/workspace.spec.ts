/**
 * (b) Adding a workspace that points at a real git repository, and creating a
 * thread in it, entirely through the UI — the M1 acceptance criterion
 * (PLAN.md §8 M1).
 */
import { expect, test } from "../src/fixtures.js";

test("adds a workspace from the rail and creates a thread in it", async ({ page, nexestra }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("form", { name: "New workspace" });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Repository path").fill(nexestra.repo);
  await dialog.getByRole("button", { name: "Add workspace" }).click();

  // A brand new workspace has no thread, so the shell offers to create one.
  await expect(page).toHaveURL(/\/w\/ws_[a-z0-9]+$/);
  await expect(page.getByText(nexestra.repo)).toBeVisible();

  await page.getByRole("button", { name: "New thread" }).click();
  const threadDialog = page.getByRole("form", { name: "New thread" });
  await threadDialog.getByLabel("Title").fill("Add a CLI to the todo app");
  await threadDialog.getByRole("button", { name: "Create thread" }).click();

  await expect(page).toHaveURL(/\/w\/ws_[a-z0-9]+\/t\/th_[a-z0-9]+\/chat$/);
  await expect(page.locator(".surface__title")).toHaveText("Chat — Add a CLI to the todo app");
  await expect(page.getByText("Describe what you want, however vaguely.")).toBeVisible();

  // It is really persisted, not just in the React cache.
  await page.reload();
  await expect(page.locator(".surface__title")).toHaveText("Chat — Add a CLI to the todo app");
});

test("rejects a path that is not a git repository", async ({ page, nexestra }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Add workspace" }).click();
  const dialog = page.getByRole("form", { name: "New workspace" });
  await dialog.getByLabel("Repository path").fill(`${nexestra.home}/definitely-not-a-repo`);
  await dialog.getByRole("button", { name: "Add workspace" }).click();

  await expect(dialog.locator(".dialog__error")).toBeVisible();
  await expect(dialog).toBeVisible();
});
