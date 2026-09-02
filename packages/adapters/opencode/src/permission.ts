/**
 * `RunSpec.sandbox` → OpenCode permissions.
 *
 * OpenCode has **no sandbox concept**: the agent runs with whatever the
 * permission ruleset allows, and the machine's global config here is
 * `permission: {"*":"allow"}` — nothing is ever asked by default. The only
 * per-run lever that does not mutate global config is the `permission` field of
 * `POST /session` (`docs/harness-protocols.md` §2.6), so the three Nexestra
 * sandbox levels are *approximated* by a ruleset plus a `tools` map on the
 * prompt. Both are belt-and-braces: a denied tool that is also switched off
 * cannot be reached at all.
 *
 * Rule resolution in OpenCode is by specificity, not by order: a rule naming a
 * concrete permission key beats `{permission:"*"}`, which is why every ruleset
 * below spells the keys out instead of relying on a trailing catch-all. The
 * recorded `plan` agent (`fixtures/opencode/agents.json`) is built the same way.
 */
import type { SandboxLevel } from "@nexestra/core";
import {
  OPENCODE_NETWORK_TOOL_IDS,
  OPENCODE_TOOL_IDS,
  OPENCODE_WRITE_TOOL_IDS,
  type ResolvedOpenCodeOptions,
} from "./options.js";
import type {
  OpenCodePermissionAction,
  OpenCodePermissionRequest,
  OpenCodePermissionRule,
  OpenCodePermissionRuleset,
} from "./types.js";

/** Permission keys OpenCode checks. Tool ids plus a few synthetic gates. */
export const OPENCODE_PERMISSION_KEYS = [
  "bash",
  "read",
  "grep",
  "glob",
  "list",
  "edit",
  "write",
  "patch",
  "apply_patch",
  "webfetch",
  "websearch",
  "task",
  "todowrite",
  "skill",
  "question",
  "doom_loop",
  /** Anything the agent touches outside the session `directory`. */
  "external_directory",
] as const;

function rule(
  permission: string,
  action: OpenCodePermissionAction,
  pattern = "*",
): OpenCodePermissionRule {
  return { permission, pattern, action };
}

const READ_ONLY_ALLOWED: readonly string[] = ["read", "grep", "glob", "list", "todowrite"];

/**
 * Build the per-session ruleset for a sandbox level.
 *
 * - `read-only` denies every write tool, network tool and (by default) `bash`,
 *   because there is no way to tell a reading command from a writing one before
 *   it runs. Set `options.readOnlyBashAction: "ask"` to route it through the
 *   Approval queue instead.
 * - `workspace-write` allows edits and `bash` inside the session directory and
 *   *asks* for everything outside it — `external_directory` covers reads and
 *   writes beyond the worktree — and for network access.
 * - `danger-full-access` allows everything, including `external_directory`.
 */
export function permissionRulesetFor(
  sandbox: SandboxLevel,
  options: Pick<ResolvedOpenCodeOptions, "permissionRuleset" | "readOnlyBashAction">,
): OpenCodePermissionRuleset {
  if (options.permissionRuleset) return options.permissionRuleset(sandbox);

  switch (sandbox) {
    case "read-only": {
      const rules: OpenCodePermissionRule[] = [];
      for (const permission of READ_ONLY_ALLOWED) rules.push(rule(permission, "allow"));
      for (const permission of OPENCODE_WRITE_TOOL_IDS) rules.push(rule(permission, "deny"));
      for (const permission of OPENCODE_NETWORK_TOOL_IDS) rules.push(rule(permission, "deny"));
      rules.push(rule("bash", options.readOnlyBashAction));
      rules.push(rule("external_directory", "deny"));
      rules.push(rule("doom_loop", "ask"));
      return rules;
    }
    case "workspace-write": {
      const rules: OpenCodePermissionRule[] = [];
      for (const permission of READ_ONLY_ALLOWED) rules.push(rule(permission, "allow"));
      for (const permission of OPENCODE_WRITE_TOOL_IDS) rules.push(rule(permission, "allow"));
      rules.push(rule("bash", "allow"));
      rules.push(rule("task", "allow"));
      rules.push(rule("skill", "allow"));
      // Everything that leaves the worktree needs a human.
      rules.push(rule("external_directory", "ask"));
      for (const permission of OPENCODE_NETWORK_TOOL_IDS) rules.push(rule(permission, "ask"));
      rules.push(rule("doom_loop", "ask"));
      return rules;
    }
    case "danger-full-access":
      return [rule("*", "allow")];
  }
}

/**
 * The `tools` map sent with the prompt.
 *
 * `RunSpec.tools`, when present, is an allow-list: everything else is switched
 * off. Write and network tools are additionally forced off below their sandbox
 * level, so a permission rule that a future OpenCode resolves differently still
 * cannot produce a write in a `read-only` run.
 */
export function toolMapFor(
  sandbox: SandboxLevel,
  requested: readonly string[] | undefined,
): Record<string, boolean> | undefined {
  const tools: Record<string, boolean> = {};
  if (requested && requested.length > 0) {
    const allowed = new Set(requested);
    for (const id of OPENCODE_TOOL_IDS) tools[id] = allowed.has(id);
    for (const id of allowed) if (!(id in tools)) tools[id] = true;
  }
  if (sandbox === "read-only") {
    for (const id of OPENCODE_WRITE_TOOL_IDS) tools[id] = false;
    for (const id of OPENCODE_NETWORK_TOOL_IDS) tools[id] = false;
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

/**
 * Risk shown next to an approval. Anything that can mutate the machine or reach
 * the network is `high`; pure reads are `low`.
 */
export function permissionRisk(permission: string): "low" | "high" {
  if (READ_ONLY_ALLOWED.includes(permission)) return "low";
  if (permission === "question") return "low";
  return "high";
}

/** Human readable one-liner for `HarnessEvent.permission_request.description`. */
export function permissionDescription(request: OpenCodePermissionRequest): string {
  const metadata = request.metadata ?? {};
  const command = metadata.command;
  if (typeof command === "string" && command.length > 0) {
    return `${request.permission}: ${command}`;
  }
  const filePath = metadata.filePath ?? metadata.path ?? metadata.file;
  if (typeof filePath === "string" && filePath.length > 0) {
    return `${request.permission}: ${filePath}`;
  }
  const patterns = request.patterns ?? [];
  return patterns.length > 0 ? `${request.permission}: ${patterns.join(" ")}` : request.permission;
}
