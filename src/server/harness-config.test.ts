import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredPermission,
  expandEnvironmentValue,
  loadHarnessConfig,
  mergePermissions,
} from "./harness-config.js";

describe("harness configuration", () => {
  it("loads JSON with comments and resolves exact and wildcard permission rules", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nexestra-config-"));
    await writeFile(
      join(workspace, "nexestra.config.json"),
      [
        "{",
        "  // Repository policy may only make an agent policy stricter.",
        '  "permission": { "*": "ask", "docs_*": "deny", "read": "allow" },',
        '  "ignore": ["generated/**"]',
        "}",
      ].join("\n"),
    );

    const config = await loadHarnessConfig(workspace);
    expect(config.ignore).toEqual(["generated/**"]);
    expect(configuredPermission(config.permission, "read")).toBe("allow");
    expect(configuredPermission(config.permission, "docs_lookup")).toBe("deny");
    expect(configuredPermission(config.permission, "bash")).toBe("ask");
    expect(mergePermissions("deny", "allow")).toBe("deny");
  });

  it("expands only explicit environment references", () => {
    expect(expandEnvironmentValue("Bearer {env:TOKEN}", { TOKEN: "secret" })).toBe("Bearer secret");
    expect(() => expandEnvironmentValue("{env:MISSING}", {})).toThrow(
      "Environment variable MISSING is not set",
    );
  });
});
