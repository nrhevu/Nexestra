import { createFixture, createTask, type Fixture, listTasks } from "../src/api.js";
import { expect, test } from "../src/fixtures.js";

let fixture: Fixture;

test.beforeEach(async ({ nexestra }) => {
  fixture = await createFixture(nexestra.baseURL, nexestra.repo, "agents");
  await createTask(nexestra.baseURL, {
    threadId: fixture.thread.id,
    title: "Implement the feature",
    assignedHarness: "codex",
  });
});

test("creates a worker agent and assigns it to a task", async ({ page, nexestra }) => {
  await page.goto(`${fixture.route}/agents`);
  await page.getByRole("button", { name: "+ New agent" }).click();

  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await dialog.getByLabel("Name").fill("Codex implementer");
  await dialog.getByLabel("Description").fill("Owns implementation tasks");
  await dialog.getByLabel("Instructions").fill("Keep changes surgical and run tests.");
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();

  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".agent-card").filter({ hasText: "Codex implementer" })).toBeVisible();

  await page.getByRole("button", { name: "Task Board" }).click();
  await page.locator(".task-card").filter({ hasText: "Implement the feature" }).click();
  await page.getByLabel("Agent profile").selectOption({ label: "Codex implementer · codex" });
  await expect(page.getByRole("combobox", { name: "Harness", exact: true })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Model", exact: true })).toBeDisabled();

  const tasks = await listTasks(nexestra.baseURL, fixture.thread.id);
  expect(tasks[0]?.agentId).toBeTruthy();
  expect(tasks[0]?.assignedHarness).toBe("codex");
});

test("creates a Nexestra agent with provider/model and selects it for chat", async ({ page }) => {
  await page.goto(`${fixture.route}/agents`);
  await page.getByRole("button", { name: "+ New agent" }).click();

  const dialog = page.getByRole("dialog", { name: "Create agent" });
  await dialog.getByLabel("Name").fill("Research lead");
  await dialog.getByRole("combobox", { name: "Harness", exact: true }).selectOption("nexestra");
  await expect(dialog.getByRole("combobox", { name: "Provider", exact: true })).toHaveValue(
    "openai",
  );
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "chat-latest",
  );
  await dialog.getByLabel("Instructions").fill("Research first, then write a concrete plan.");
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();

  const card = page.locator(".agent-card").filter({ hasText: "Research lead" });
  await card.getByRole("button", { name: "Use in this chat" }).click();
  await expect(card).toContainText("Active in chat");

  await page.getByRole("button", { name: "Workspace / Chat" }).click();
  await expect(page.getByLabel("Master agent")).toHaveValue(/agent_/);
  await expect(page.locator(".sidebar")).toContainText("chat-latest");
});
