import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MasterAgent, ToolCall } from "../shared/contracts.js";
import { executeMasterTool, type MasterToolContext } from "./master-harness.js";

describe("Master harness tools", () => {
  it("lists, searches, reads, edits, writes, and runs bounded shell commands", async () => {
    const context = await toolContext({ read: "allow", edit: "allow", bash: "allow" });
    await mkdir(join(context.workspacePath, "src"));
    await writeFile(join(context.workspacePath, "src", "alpha.ts"), "export const alpha = 1;\n");

    await expect(call(context, "list", { path: "src", depth: 1 })).resolves.toContain(
      "src/alpha.ts",
    );
    await expect(call(context, "glob", { pattern: "**/*.ts" })).resolves.toContain("src/alpha.ts");
    await expect(call(context, "grep", { query: "alpha", path: "src" })).resolves.toContain(
      "src/alpha.ts:1",
    );
    await expect(call(context, "read", { path: "src/alpha.ts" })).resolves.toContain(
      "export const alpha",
    );
    await expect(
      call(context, "edit", {
        path: "src/alpha.ts",
        old_text: "alpha = 1",
        new_text: "alpha = 2",
      }),
    ).resolves.toContain("Updated src/alpha.ts");
    await expect(
      call(context, "write", { path: "src/beta.ts", content: "export const beta = 3;\n" }),
    ).resolves.toContain("Wrote src/beta.ts");
    await expect(call(context, "bash", { command: "pwd && printf harness" })).resolves.toContain(
      "harness\n[exit 0]",
    );

    expect(await readFile(join(context.workspacePath, "src", "alpha.ts"), "utf8")).toContain(
      "alpha = 2",
    );
    expect(await readFile(join(context.workspacePath, "src", "beta.ts"), "utf8")).toContain(
      "beta = 3",
    );
  });

  it("confines file tools to the repository and protects credentials through symlinks", async () => {
    const context = await toolContext({ read: "allow", edit: "allow", bash: "deny" });
    const outside = await mkdtemp(join(tmpdir(), "nexestra-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(context.workspacePath, "escape.txt"));
    await mkdir(context.dataPath, { recursive: true });
    await writeFile(join(context.dataPath, "credentials.json"), "secret-key");

    await expect(call(context, "read", { path: "../secret.txt" })).resolves.toContain(
      "Path escapes",
    );
    await expect(call(context, "read", { path: "escape.txt" })).resolves.toContain(
      "outside the repository",
    );
    await expect(call(context, "read", { path: ".nexestra/credentials.json" })).resolves.toContain(
      "protected",
    );

    const updates: ToolCall[] = [];
    context.hooks = {
      update: async (toolCall) => {
        updates.push(toolCall);
      },
      requestApproval: async () => true,
    };
    await expect(call(context, "bash", { command: "touch blocked.txt" })).resolves.toContain(
      "Permission denied",
    );
    await expect(readFile(join(context.workspacePath, "blocked.txt"), "utf8")).rejects.toThrow();
    expect(updates).toMatchObject([{ name: "bash", status: "denied" }]);
  });

  it("pauses ask permissions and records only redacted tool metadata", async () => {
    const context = await toolContext({ read: "allow", edit: "ask", bash: "deny" });
    const updates: ToolCall[] = [];
    context.hooks = {
      update: async (toolCall) => {
        updates.push(toolCall);
      },
      requestApproval: async (toolCall) => {
        updates.push(toolCall);
        return true;
      },
    };

    await call(context, "write", { path: "approved.txt", content: "secret-key" });

    expect(updates.map((update) => update.status)).toEqual([
      "waiting_approval",
      "running",
      "completed",
    ]);
    expect(updates.map((update) => update.input).join(" ")).not.toContain("secret-key");
  });
});

async function toolContext(permissions: MasterAgent["permissions"]): Promise<MasterToolContext> {
  const workspacePath = await mkdtemp(join(tmpdir(), "nexestra-tools-"));
  const dataPath = join(workspacePath, ".nexestra");
  const now = new Date().toISOString();
  const agent: MasterAgent = {
    id: "master-agent",
    workspaceId: "workspace",
    kind: "master",
    name: "Master",
    handle: "master",
    description: "",
    instructions: "",
    enabled: true,
    archived: false,
    permissions,
    provider: {
      type: "custom",
      name: "Test",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "test",
      protocol: "openai-chat",
      hasCredential: false,
    },
    createdAt: now,
    updatedAt: now,
  };
  return {
    agent,
    runId: "run",
    threadId: "thread",
    workspacePath,
    dataPath,
    redact: (value) => value.replaceAll("secret-key", "[REDACTED]"),
  };
}

function call(context: MasterToolContext, name: string, args: Record<string, unknown>) {
  return executeMasterTool(
    { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) },
    context,
  );
}
