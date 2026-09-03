import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MasterAccessMode, MasterAgent, ToolCall } from "../shared/contracts.js";
import {
  createMasterToolSession,
  executeMasterTool,
  type MasterToolContext,
} from "./master-harness.js";

describe("Master harness tools", () => {
  it("lists, searches, reads, edits, writes, and runs bounded shell commands", async () => {
    const context = await toolContext("full");
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
    const context = await toolContext("full");
    const outside = await mkdtemp(join(tmpdir(), "nexestra-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(context.workspacePath, "escape.txt"));
    await mkdir(context.dataPath, { recursive: true });
    await writeFile(join(context.dataPath, "credentials.json"), "secret-key");
    await writeFile(
      join(context.workspacePath, "nexestra.config.json"),
      JSON.stringify({ permission: { bash: "deny" } }),
    );

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
    const context = await toolContext("ask");
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

  it("runs built-in tools automatically in auto mode but asks before custom tools", async () => {
    const context = await toolContext("auto");
    const directory = join(context.workspacePath, ".opencode", "tools");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "greet.mjs"),
      "export default { description: 'Greet.', execute() { return 'hello'; } };",
    );
    const statuses: ToolCall["status"][] = [];
    context.hooks = {
      update: async (toolCall) => {
        statuses.push(toolCall.status);
      },
      requestApproval: async (toolCall) => {
        statuses.push(toolCall.status);
        return true;
      },
    };
    const session = await createMasterToolSession(context);
    try {
      await callSession(session, "write", { path: "automatic.txt", content: "done\n" });
      await callSession(session, "greet", {});
    } finally {
      await session.close();
    }

    expect(statuses).toEqual(["running", "completed", "waiting_approval", "running", "completed"]);
  });

  it("applies add, update, move, and delete patch operations", async () => {
    const context = await toolContext("full");
    await writeFile(join(context.workspacePath, "move-me.txt"), "alpha\n");
    await writeFile(join(context.workspacePath, "remove-me.txt"), "obsolete\n");

    const result = await call(context, "apply_patch", {
      patchText: [
        "*** Begin Patch",
        "*** Update File: move-me.txt",
        "*** Move to: moved.txt",
        "@@",
        "-alpha",
        "+beta",
        "*** Add File: added.txt",
        "+new file",
        "*** Delete File: remove-me.txt",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result).toContain("Moved move-me.txt to moved.txt");
    expect(await readFile(join(context.workspacePath, "moved.txt"), "utf8")).toBe("beta\n");
    expect(await readFile(join(context.workspacePath, "added.txt"), "utf8")).toBe("new file\n");
    await expect(readFile(join(context.workspacePath, "move-me.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(context.workspacePath, "remove-me.txt"), "utf8")).rejects.toThrow();
  });

  it("loads skills and keeps a todo list inside one tool session", async () => {
    const context = await toolContext("full");
    const skillDirectory = join(context.workspacePath, ".opencode", "skills", "review-code");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review-code\ndescription: Review changes carefully.\n---\n\nCheck the diff.\n",
    );
    const session = await createMasterToolSession(context);
    try {
      expect(session.definitions.find((tool) => tool.name === "skill")?.description).toContain(
        "review-code",
      );
      await expect(callSession(session, "skill", { name: "review-code" })).resolves.toContain(
        "Check the diff",
      );
      await expect(
        callSession(session, "todowrite", {
          todos: [{ id: "one", content: "Inspect code", status: "in_progress", priority: "high" }],
        }),
      ).resolves.toContain("Inspect code");
    } finally {
      await session.close();
    }
  });

  it("respects repository and Nexestra ignore patterns in discovery tools", async () => {
    const context = await toolContext("full");
    await writeFile(join(context.workspacePath, ".gitignore"), "ignored.log\n");
    await writeFile(join(context.workspacePath, "ignored.log"), "hidden\n");
    await writeFile(join(context.workspacePath, "visible.ts"), "visible\n");
    await writeFile(
      join(context.workspacePath, "nexestra.config.json"),
      JSON.stringify({ ignore: ["visible.ts"] }),
    );

    await expect(call(context, "glob", { pattern: "**/*" })).resolves.not.toContain("ignored.log");
    await expect(call(context, "glob", { pattern: "**/*" })).resolves.not.toContain("visible.ts");
    await writeFile(join(context.workspacePath, ".ignore"), "!ignored.log\n");
    await expect(call(context, "glob", { pattern: "**/*" })).resolves.toContain("ignored.log");
  });

  it("loads OpenCode-style custom tool modules with external permission", async () => {
    const context = await toolContext("full");
    const directory = join(context.workspacePath, ".opencode", "tools");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "greet.mjs"),
      [
        "export default {",
        "  description: 'Greet a person.',",
        "  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },",
        "  execute(args, context) { return 'Hello ' + args.name + ' from @' + context.agent },",
        "};",
      ].join("\n"),
    );
    const session = await createMasterToolSession(context);
    try {
      expect(session.definitions.some((tool) => tool.name === "greet")).toBe(true);
      await expect(callSession(session, "greet", { name: "Ada" })).resolves.toBe(
        "Hello Ada from @master",
      );
    } finally {
      await session.close();
    }
  });

  it("does not follow custom-tool or skill roots outside the allowed directories", async () => {
    const context = await toolContext("full");
    const outside = await mkdtemp(join(tmpdir(), "nexestra-outside-"));
    const outsideTools = join(outside, "tools");
    const outsideSkills = join(outside, "skills");
    await mkdir(outsideTools, { recursive: true });
    await mkdir(join(outsideSkills, "outside-skill"), { recursive: true });
    await writeFile(
      join(outsideTools, "outside.mjs"),
      "export default { description: 'Outside.', execute() { return 'outside'; } };",
    );
    await writeFile(
      join(outsideSkills, "outside-skill", "SKILL.md"),
      "---\nname: outside-skill\ndescription: Outside.\n---\n",
    );
    await mkdir(join(context.workspacePath, ".opencode"), { recursive: true });
    await mkdir(join(context.workspacePath, ".agents"), { recursive: true });
    await symlink(outsideTools, join(context.workspacePath, ".opencode", "tools"), "dir");
    await symlink(outsideSkills, join(context.workspacePath, ".agents", "skills"), "dir");

    const session = await createMasterToolSession(context);
    try {
      expect(session.definitions.some((tool) => tool.name === "outside")).toBe(false);
      expect(session.definitions.find((tool) => tool.name === "skill")?.description).not.toContain(
        "outside-skill",
      );
    } finally {
      await session.close();
    }
  });

  it("fetches and searches the web through bounded, permissioned tools", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const context = await toolContext("full");
    context.resolveHost = async () => ["93.184.216.34"];
    context.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("mcp.exa.ai")) {
        const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "test-search", version: "1" },
              },
            }),
            { headers: { "content-type": "application/json", "mcp-session-id": "search" } },
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "Search result" }] },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<h1>Title</h1><p>Hello &amp; goodbye.</p>", {
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    await expect(
      call(context, "webfetch", { url: "https://example.com/page", format: "markdown" }),
    ).resolves.toContain("# Title");
    await expect(call(context, "websearch", { query: "Nexestra" })).resolves.toBe("Search result");
    expect(requests[0]?.url).toBe("https://example.com/page");
    expect(requests.slice(1).every((request) => request.url === "https://mcp.exa.ai/mcp")).toBe(
      true,
    );
    await expect(call(context, "webfetch", { url: "http://127.0.0.1/private" })).resolves.toContain(
      "Private-network web URLs are blocked",
    );
  });

  it("pauses question tools until the user supplies an answer", async () => {
    const context = await toolContext("ask");
    const statuses: ToolCall["status"][] = [];
    context.hooks = {
      update: async (toolCall) => {
        statuses.push(toolCall.status);
      },
      requestApproval: async () => true,
      requestInput: async (toolCall) => {
        statuses.push(toolCall.status);
        return [["Proceed"]];
      },
    };

    await expect(
      call(context, "question", {
        questions: [
          {
            header: "Decision",
            question: "Continue?",
            options: [{ label: "Proceed", description: "Keep going." }],
          },
        ],
      }),
    ).resolves.toContain('"Continue?"="Proceed"');
    expect(statuses).toEqual(["running", "waiting_input", "running", "completed"]);
  });
});

async function toolContext(accessMode: MasterAccessMode): Promise<MasterToolContext> {
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
    accessMode,
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
    env: { ...process.env, HOME: workspacePath, XDG_CONFIG_HOME: join(workspacePath, ".config") },
    redact: (value) => value.replaceAll("secret-key", "[REDACTED]"),
  };
}

function callSession(
  session: Awaited<ReturnType<typeof createMasterToolSession>>,
  name: string,
  args: Record<string, unknown>,
) {
  return session.execute({ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) });
}

function call(context: MasterToolContext, name: string, args: Record<string, unknown>) {
  return executeMasterTool(
    { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) },
    context,
  );
}
