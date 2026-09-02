import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HarnessInfoSchema } from "@nexestra/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCodex,
  findCodexBinary,
  isSupportedCodexVersion,
  parseCodexVersion,
} from "./discover.js";
import { resolveOptions, TESTED_CODEX_VERSION } from "./options.js";
import { FAKE_CODEX_SCRIPT } from "./test-support.js";

let root: string;
let binDir: string;
let binary: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-discover-"));
  binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  binary = path.join(binDir, "codex");
  await writeFile(binary, FAKE_CODEX_SCRIPT, "utf8");
  await chmod(binary, 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseCodexVersion", () => {
  it("reads the version out of `codex --version`", () => {
    expect(parseCodexVersion("codex-cli 0.148.0")).toBe("0.148.0");
    expect(parseCodexVersion("codex-cli 0.153.0-alpha.4\n")).toBe("0.153.0-alpha.4");
  });

  it("returns undefined for unrecognisable output", () => {
    expect(parseCodexVersion("")).toBeUndefined();
    expect(parseCodexVersion("command not found")).toBeUndefined();
  });
});

describe("isSupportedCodexVersion", () => {
  it("accepts the contract-tested range", () => {
    expect(isSupportedCodexVersion("0.140.0")).toBe(true);
    expect(isSupportedCodexVersion(TESTED_CODEX_VERSION)).toBe(true);
    expect(isSupportedCodexVersion("0.149.99")).toBe(true);
  });

  it("rejects versions outside it", () => {
    expect(isSupportedCodexVersion("0.139.9")).toBe(false);
    expect(isSupportedCodexVersion("0.150.0")).toBe(false);
    expect(isSupportedCodexVersion("1.0.0")).toBe(false);
  });
});

describe("findCodexBinary", () => {
  it("prefers an explicit override", async () => {
    const found = await findCodexBinary(resolveOptions({ binaryPath: binary }));
    expect(found).toBe(binary);
  });

  it("returns undefined when the override is missing", async () => {
    const found = await findCodexBinary(
      resolveOptions({ binaryPath: path.join(root, "nope", "codex") }),
    );
    expect(found).toBeUndefined();
  });

  it("searches PATH", async () => {
    const previous = process.env.PATH;
    process.env.PATH = binDir;
    try {
      expect(await findCodexBinary(resolveOptions({ extraSearchPaths: [] }))).toBe(binary);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("falls back to the extra search paths", async () => {
    const previous = process.env.PATH;
    process.env.PATH = path.join(root, "empty");
    try {
      const found = await findCodexBinary(resolveOptions({ extraSearchPaths: [binDir] }));
      expect(found).toBe(binary);
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("discoverCodex", () => {
  it("reports a healthy, tested installation", async () => {
    const info = await discoverCodex(resolveOptions({ binaryPath: binary }));
    expect(() => HarnessInfoSchema.parse(info)).not.toThrow();
    expect(info).toMatchObject({
      id: "codex",
      available: true,
      binaryPath: binary,
      version: TESTED_CODEX_VERSION,
      authOk: true,
      warnings: [],
    });
    expect(info.sandboxModes).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(info.supportedVersionRange).toBe(">=0.140.0 <0.150.0");
  });

  it("warns when the installed version differs from the tested one", async () => {
    const info = await discoverCodex(
      resolveOptions({ binaryPath: binary, env: { FAKE_VERSION: "0.149.2" } }),
    );
    expect(info.version).toBe("0.149.2");
    expect(info.warnings.join(" ")).toContain("differs from the tested version");
    expect(info.warnings.join(" ")).toContain("no published schema");
  });

  it("warns harder when the version is outside the supported range", async () => {
    const info = await discoverCodex(
      resolveOptions({ binaryPath: binary, env: { FAKE_VERSION: "0.160.0" } }),
    );
    expect(info.warnings.join(" ")).toContain("outside the contract-tested range");
  });

  it("reports a logged-out installation", async () => {
    const info = await discoverCodex(
      resolveOptions({
        binaryPath: binary,
        env: { FAKE_LOGIN: "Not logged in", FAKE_LOGIN_EXIT: "1" },
      }),
    );
    expect(info.authOk).toBe(false);
    expect(info.warnings.join(" ")).toContain("codex login");
  });

  it("reports a missing binary without throwing", async () => {
    const info = await discoverCodex(
      resolveOptions({ binaryPath: path.join(root, "nope", "codex") }),
    );
    expect(info.available).toBe(false);
    expect(info.binaryPath).toBeUndefined();
    expect(info.authOk).toBe(false);
    expect(info.warnings[0]).toContain("not executable");
    expect(() => HarnessInfoSchema.parse(info)).not.toThrow();
  });

  it("surfaces the configured model list", async () => {
    const info = await discoverCodex(
      resolveOptions({
        binaryPath: binary,
        models: ["gpt-5.1-codex"],
        defaultModel: "gpt-5.1-codex",
      }),
    );
    expect(info.models).toEqual(["gpt-5.1-codex"]);
    expect(info.defaultModel).toBe("gpt-5.1-codex");
  });
});
