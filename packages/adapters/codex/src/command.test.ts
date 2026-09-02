import type { RunSpec } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { buildCodexCommand } from "./command.js";
import { CodexPrepareError } from "./errors.js";
import { resolveOptions } from "./options.js";
import { loadFixture } from "./test-support.js";

const CONTEXT = { lastMessagePath: "/work/.nexestra/runs/run_1/last-message.md" };

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    taskId: "task_1",
    kind: "execute",
    cwd: "/work",
    instructions: "Add a function add(a, b).",
    sandbox: "workspace-write",
    timeoutMs: 600_000,
    ...overrides,
  };
}

describe("buildCodexCommand — codex exec", () => {
  it("builds the documented command line", () => {
    const line = buildCodexCommand(
      "/bin/codex",
      spec({ model: "gpt-5.1-codex" }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.command).toBe("/bin/codex");
    expect(line.args).toEqual([
      "exec",
      "--json",
      "-C",
      "/work",
      "-s",
      "workspace-write",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.1-codex",
      "-o",
      "/work/.nexestra/runs/run_1/last-message.md",
      "Add a function add(a, b).",
    ]);
    expect(line.review).toBe(false);
    expect(line.cwd).toBe("/work");
  });

  it("matches the argv of the recorded fixtures", () => {
    const fixture = loadFixture("exec-edit-test");
    const line = buildCodexCommand(
      "codex",
      spec({ cwd: fixture.meta.cwd, instructions: fixture.meta.argv.at(-1) ?? "" }),
      resolveOptions(),
      { lastMessagePath: "/WORK/out/a-last.md" },
    );
    // Same flags and values as the recording; only the ordering differs.
    expect(["codex", ...line.args].sort()).toEqual(fixture.meta.argv.sort());
  });

  it("maps RunSpec.reasoning onto -c model_reasoning_effort", () => {
    const line = buildCodexCommand(
      "codex",
      spec({ reasoning: "xhigh" }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.args).toContain("model_reasoning_effort=xhigh");
    const index = line.args.indexOf("model_reasoning_effort=xhigh");
    expect(line.args[index - 1]).toBe("-c");
  });

  it("adds --output-schema when a schema file was written", () => {
    const line = buildCodexCommand("codex", spec(), resolveOptions(), {
      ...CONTEXT,
      outputSchemaPath: "/work/.nexestra/runs/run_1/output-schema.json",
    });
    expect(line.args).toContain("--output-schema");
  });

  it("adds --ephemeral and --ignore-user-config from options", () => {
    const line = buildCodexCommand(
      "codex",
      spec(),
      resolveOptions({ ephemeral: true, ignoreUserConfig: true }),
      CONTEXT,
    );
    expect(line.args).toContain("--ephemeral");
    expect(line.args).toContain("--ignore-user-config");
  });

  it("injects MCP servers as -c mcp_servers.* TOML overrides", () => {
    const line = buildCodexCommand(
      "codex",
      spec({
        mcpServers: [
          { name: "fs", transport: "stdio", command: "npx", args: ["-y", "@mcp/fs"] },
          { name: "docs", transport: "http", url: "https://example.test/mcp", args: [] },
        ],
      }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.args).toContain('mcp_servers.fs.command="npx"');
    expect(line.args).toContain('mcp_servers.fs.args=["-y","@mcp/fs"]');
    expect(line.args).toContain('mcp_servers.docs.url="https://example.test/mcp"');
  });

  it("rejects an MCP server with no command and no url", () => {
    expect(() =>
      buildCodexCommand(
        "codex",
        spec({ mcpServers: [{ name: "broken", transport: "stdio", args: [] }] }),
        resolveOptions(),
        CONTEXT,
      ),
    ).toThrow(CodexPrepareError);
  });

  it("warns about knobs codex exec cannot honour", () => {
    const line = buildCodexCommand(
      "codex",
      spec({ tools: ["bash"], skills: ["refactor"] }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.warnings.join(" ")).toContain("RunSpec.tools is ignored");
    expect(line.warnings.join(" ")).toContain("no skills flag");
  });

  it("refuses an empty prompt", () => {
    expect(() =>
      buildCodexCommand("codex", spec({ instructions: "  " }), resolveOptions(), CONTEXT),
    ).toThrow(/needs a prompt/);
  });

  it("appends extraArgs verbatim before the prompt", () => {
    const line = buildCodexCommand(
      "codex",
      spec(),
      resolveOptions({ extraArgs: ["--add-dir", "/shared"] }),
      CONTEXT,
    );
    expect(line.args.slice(-3)).toEqual(["--add-dir", "/shared", "Add a function add(a, b)."]);
  });
});

describe("buildCodexCommand — codex exec review", () => {
  it("defaults to --uncommitted with no prompt", () => {
    const line = buildCodexCommand(
      "codex",
      spec({ kind: "review", instructions: "", sandbox: "read-only" }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.args).toEqual([
      "exec",
      "review",
      "--json",
      "--skip-git-repo-check",
      "-o",
      CONTEXT.lastMessagePath,
      "--uncommitted",
    ]);
    expect(line.review).toBe(true);
    // review has neither -C nor -s (checked against `codex exec review --help`)
    expect(line.args).not.toContain("-C");
    expect(line.args).not.toContain("-s");
  });

  it("refuses --uncommitted together with a prompt, as the CLI does", () => {
    expect(() =>
      buildCodexCommand(
        "codex",
        spec({ kind: "review", instructions: "Review this briefly." }),
        resolveOptions(),
        CONTEXT,
      ),
    ).toThrow(/cannot be combined with a prompt/);
  });

  it("passes a base ref and keeps the prompt", () => {
    const line = buildCodexCommand(
      "codex",
      spec({
        kind: "review",
        instructions: "Focus on error handling.",
        reviewTarget: { mode: "base", ref: "main" },
      }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.args.slice(-3)).toEqual(["--base", "main", "Focus on error handling."]);
  });

  it("passes a commit sha", () => {
    const line = buildCodexCommand(
      "codex",
      spec({ kind: "review", instructions: "", reviewTarget: { mode: "commit", sha: "abc123" } }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.args.slice(-2)).toEqual(["--commit", "abc123"]);
  });

  it("warns that review ignores the requested sandbox", () => {
    const line = buildCodexCommand(
      "codex",
      spec({ kind: "review", instructions: "", sandbox: "danger-full-access" }),
      resolveOptions(),
      CONTEXT,
    );
    expect(line.warnings.join(" ")).toContain("no -s flag");
  });
});
