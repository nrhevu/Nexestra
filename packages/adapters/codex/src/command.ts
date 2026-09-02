/**
 * Command-line construction for `codex exec` / `codex exec review`.
 *
 * Every flag below was checked against `codex exec --help` on CLI 0.148.0 and
 * against the recorded `argv` in `fixtures/codex/*.meta.json`.
 */
import type { McpServerRef, RunSpec } from "@nexestra/core";
import { CodexPrepareError } from "./errors.js";
import {
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  type CodexReasoningEffort,
  REASONING_TO_CODEX_EFFORT,
  type ResolvedCodexOptions,
} from "./options.js";

export interface CodexCommandContext {
  /** File `-o/--output-last-message` writes the final message to. */
  lastMessagePath: string;
  /** File `--output-schema` points at, when a schema is in play. */
  outputSchemaPath?: string;
}

export interface CodexCommandLine {
  command: string;
  args: string[];
  /** Child process cwd. Always `spec.cwd`; `exec` also gets `-C`. */
  cwd: string;
  /** True when the run is `codex exec review` (no `-C`, no `-s`). */
  review: boolean;
  /** Warnings worth surfacing to the operator (unsupported knobs, …). */
  warnings: string[];
}

function isReasoningEffort(value: string): value is CodexReasoningEffort {
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** `-c key=value`; the value half is parsed as TOML, so strings need quotes. */
function tomlLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function mcpOverrides(servers: readonly McpServerRef[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const key = `mcp_servers.${server.name}`;
    if (server.transport === "http") {
      if (!server.url) {
        throw new CodexPrepareError(`MCP server "${server.name}" has transport http but no url`);
      }
      args.push("-c", `${key}.url=${tomlLiteral(server.url)}`);
      continue;
    }
    if (!server.command) {
      throw new CodexPrepareError(`MCP server "${server.name}" has transport stdio but no command`);
    }
    args.push("-c", `${key}.command=${tomlLiteral(server.command)}`);
    if (server.args.length > 0) {
      args.push("-c", `${key}.args=${tomlLiteral(server.args)}`);
    }
  }
  return args;
}

/**
 * Build the exact argv for one run.
 *
 * `codex exec` layout (§1.1):
 * `codex exec --json -C <cwd> -m <model> -s <sandbox> --skip-git-repo-check
 *  -o <last-message> [--ephemeral] [--output-schema <file>]
 *  [-c model_reasoning_effort=<level>] [-c mcp_servers…] "<prompt>"`
 *
 * The prompt goes in argv and stdin is closed by the spawner: with a non-TTY
 * stdin Codex appends whatever it reads as a `<stdin>` block to the prompt.
 */
export function buildCodexCommand(
  binary: string,
  spec: RunSpec,
  options: ResolvedCodexOptions,
  context: CodexCommandContext,
): CodexCommandLine {
  const warnings: string[] = [];
  const review = spec.kind === "review";
  const args: string[] = review ? ["exec", "review", "--json"] : ["exec", "--json"];

  if (!review) {
    args.push("-C", spec.cwd);
    if (!CODEX_SANDBOX_MODES.includes(spec.sandbox)) {
      throw new CodexPrepareError(
        `unsupported sandbox "${spec.sandbox}"; codex accepts ${CODEX_SANDBOX_MODES.join(", ")}`,
      );
    }
    args.push("-s", spec.sandbox);
  } else if (spec.sandbox !== "read-only") {
    // `codex exec review` exposes neither -C nor -s (checked on 0.148.0).
    warnings.push(
      `codex exec review has no -s flag; the requested sandbox "${spec.sandbox}" is ignored and the review runs with Codex' own defaults`,
    );
  }

  args.push("--skip-git-repo-check");

  const model = spec.model ?? options.defaultModel;
  if (model) args.push("-m", model);

  if (options.ephemeral) args.push("--ephemeral");
  if (options.ignoreUserConfig) args.push("--ignore-user-config");

  args.push("-o", context.lastMessagePath);
  if (context.outputSchemaPath) args.push("--output-schema", context.outputSchemaPath);

  if (spec.reasoning) {
    const effort = REASONING_TO_CODEX_EFFORT[spec.reasoning];
    if (!isReasoningEffort(effort)) {
      throw new CodexPrepareError(`unsupported reasoning level "${spec.reasoning}"`);
    }
    // Codex accepts an unknown value silently, so this is validated here.
    args.push("-c", `model_reasoning_effort=${effort}`);
  }

  for (const [key, value] of Object.entries(options.configOverrides)) {
    args.push("-c", `${key}=${value}`);
  }

  if (spec.mcpServers && spec.mcpServers.length > 0) {
    args.push(...mcpOverrides(spec.mcpServers));
  }

  if (spec.tools && spec.tools.length > 0) {
    warnings.push("codex exec cannot select tools per run; RunSpec.tools is ignored");
  }
  if (spec.skills && spec.skills.length > 0) {
    warnings.push("codex exec has no skills flag; use AGENTS.md in the worktree instead");
  }

  args.push(...options.extraArgs);

  const prompt = spec.instructions.trim();
  if (review) {
    const target = spec.reviewTarget ?? { mode: "uncommitted" as const };
    switch (target.mode) {
      case "uncommitted":
        if (prompt.length > 0) {
          throw new CodexPrepareError(
            "codex exec review --uncommitted cannot be combined with a prompt " +
              "(the CLI exits 2). Leave RunSpec.instructions empty, or set " +
              "reviewTarget to {mode:'base'} / {mode:'commit'}.",
          );
        }
        args.push("--uncommitted");
        break;
      case "base":
        args.push("--base", target.ref);
        if (prompt.length > 0) args.push(prompt);
        break;
      case "commit":
        args.push("--commit", target.sha);
        if (prompt.length > 0) args.push(prompt);
        break;
    }
  } else {
    if (prompt.length === 0) {
      throw new CodexPrepareError("RunSpec.instructions is empty; codex exec needs a prompt");
    }
    args.push(prompt);
  }

  return { command: binary, args, cwd: spec.cwd, review, warnings };
}
