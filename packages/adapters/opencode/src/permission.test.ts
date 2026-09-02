import { describe, expect, it } from "vitest";
import { resolveOptions } from "./options.js";
import {
  permissionDescription,
  permissionRisk,
  permissionRulesetFor,
  toolMapFor,
} from "./permission.js";
import type { OpenCodePermissionRuleset } from "./types.js";

function actionOf(ruleset: OpenCodePermissionRuleset, permission: string): string | undefined {
  return ruleset.find((rule) => rule.permission === permission)?.action;
}

describe("permissionRulesetFor", () => {
  const options = resolveOptions();

  it("denies every mutation and the network under read-only", () => {
    const ruleset = permissionRulesetFor("read-only", options);
    for (const permission of ["edit", "write", "apply_patch", "patch"]) {
      expect(actionOf(ruleset, permission), permission).toBe("deny");
    }
    expect(actionOf(ruleset, "webfetch")).toBe("deny");
    expect(actionOf(ruleset, "external_directory")).toBe("deny");
    // There is no way to tell a reading command from a writing one before it
    // runs, so bash is denied outright by default.
    expect(actionOf(ruleset, "bash")).toBe("deny");
    expect(actionOf(ruleset, "read")).toBe("allow");
    expect(actionOf(ruleset, "grep")).toBe("allow");
  });

  it("can route read-only bash through the approval queue instead", () => {
    const ruleset = permissionRulesetFor(
      "read-only",
      resolveOptions({ readOnlyBashAction: "ask" }),
    );
    expect(actionOf(ruleset, "bash")).toBe("ask");
  });

  it("asks for anything outside the worktree or on the network under workspace-write", () => {
    const ruleset = permissionRulesetFor("workspace-write", options);
    expect(actionOf(ruleset, "edit")).toBe("allow");
    expect(actionOf(ruleset, "bash")).toBe("allow");
    expect(actionOf(ruleset, "external_directory")).toBe("ask");
    expect(actionOf(ruleset, "webfetch")).toBe("ask");
    expect(actionOf(ruleset, "websearch")).toBe("ask");
  });

  it("allows everything under danger-full-access", () => {
    expect(permissionRulesetFor("danger-full-access", options)).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("never relies on rule order alone", () => {
    // OpenCode resolves by specificity, so a catch-all must not be the only
    // thing standing between a read-only run and an edit.
    const ruleset = permissionRulesetFor("read-only", options);
    expect(ruleset.some((rule) => rule.permission === "*")).toBe(false);
  });

  it("honours a caller-supplied mapping", () => {
    const custom = resolveOptions({
      permissionRuleset: () => [{ permission: "bash", pattern: "*", action: "ask" }],
    });
    expect(permissionRulesetFor("danger-full-access", custom)).toEqual([
      { permission: "bash", pattern: "*", action: "ask" },
    ]);
  });
});

describe("toolMapFor", () => {
  it("switches the write and network tools off under read-only", () => {
    const tools = toolMapFor("read-only", undefined);
    expect(tools).toMatchObject({
      edit: false,
      write: false,
      apply_patch: false,
      webfetch: false,
      websearch: false,
    });
  });

  it("treats RunSpec.tools as an allow-list", () => {
    const tools = toolMapFor("workspace-write", ["read", "grep"]);
    expect(tools?.read).toBe(true);
    expect(tools?.grep).toBe(true);
    expect(tools?.bash).toBe(false);
    expect(tools?.edit).toBe(false);
  });

  it("passes an unknown tool id through, so plugins still work", () => {
    expect(toolMapFor("workspace-write", ["my_plugin_tool"])?.my_plugin_tool).toBe(true);
  });

  it("sends nothing when there is nothing to restrict", () => {
    expect(toolMapFor("danger-full-access", undefined)).toBeUndefined();
  });
});

describe("permission presentation", () => {
  it("scores writes, shells and the network as high risk", () => {
    expect(permissionRisk("bash")).toBe("high");
    expect(permissionRisk("edit")).toBe("high");
    expect(permissionRisk("external_directory")).toBe("high");
    expect(permissionRisk("read")).toBe("low");
  });

  it("prefers the command, then the path, then the patterns", () => {
    expect(
      permissionDescription({
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["node *"],
        metadata: { command: "node --test" },
      }),
    ).toBe("bash: node --test");
    expect(
      permissionDescription({
        id: "per_1",
        sessionID: "ses_1",
        permission: "edit",
        patterns: ["src/*"],
        metadata: { filePath: "src/a.ts" },
      }),
    ).toBe("edit: src/a.ts");
    expect(
      permissionDescription({
        id: "per_1",
        sessionID: "ses_1",
        permission: "webfetch",
        patterns: ["https://example.com"],
      }),
    ).toBe("webfetch: https://example.com");
  });
});
