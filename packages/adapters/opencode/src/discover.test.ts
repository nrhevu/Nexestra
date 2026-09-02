import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultModelFrom,
  discoverOpenCode,
  isSupportedOpenCodeVersion,
  modelsFromProviders,
  parseOpenCodeVersion,
} from "./discover.js";
import { type OpenCodeAdapterOptions, resolveOptions } from "./options.js";
import { OpenCodeServerManager } from "./server.js";
import { FAKE_OPENCODE_SCRIPT, FakeOpenCodeServer } from "./test-support.js";
import type { OpenCodeProviderList } from "./types.js";

let root: string;
let binary: string;
let workspace: string;
const managers: OpenCodeServerManager[] = [];

const PROVIDERS: OpenCodeProviderList = {
  all: [
    { id: "openai", name: "OpenAI", models: { "gpt-5.4-mini": {}, "gpt-5.4": {} } },
    { id: "9router", name: "9router", models: { "dsv4/deepseek-v4-flash-0731": {} } },
  ],
  default: { openai: "gpt-5.4-mini", "9router": "dsv4/deepseek-v4-flash-0731" },
  connected: ["openai"],
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-opencode-discover-"));
  binary = path.join(root, "opencode");
  workspace = path.join(root, "repo");
  await writeFile(binary, FAKE_OPENCODE_SCRIPT, "utf8");
  await chmod(binary, 0o755);
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll().catch(() => {})));
  await rm(root, { recursive: true, force: true });
});

function context(overrides: OpenCodeAdapterOptions = {}) {
  const options = resolveOptions({
    binaryPath: binary,
    startTimeoutMs: 10_000,
    killGraceMs: 1000,
    ...overrides,
  });
  const manager = new OpenCodeServerManager({ binary: async () => binary, options });
  managers.push(manager);
  return { options, manager, directory: workspace };
}

describe("version helpers", () => {
  it("parses the bare version opencode prints", () => {
    expect(parseOpenCodeVersion("1.18.25\n")).toBe("1.18.25");
    expect(parseOpenCodeVersion("opencode 1.19.0-beta.1")).toBe("1.19.0-beta.1");
    expect(parseOpenCodeVersion("no version here")).toBeUndefined();
  });

  it("bounds the contract-tested range", () => {
    expect(isSupportedOpenCodeVersion("1.18.25")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.18.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.17.9")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.0.0")).toBe(false);
  });
});

describe("provider catalogue", () => {
  it("lists connected providers first", () => {
    expect(modelsFromProviders(PROVIDERS)).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "9router/dsv4/deepseek-v4-flash-0731",
    ]);
  });

  it("prefers a connected provider's default model", () => {
    // §4.5: the machine default pointed at an unreachable local proxy.
    expect(defaultModelFrom(PROVIDERS)).toBe("openai/gpt-5.4-mini");
    expect(defaultModelFrom({ all: [], default: {}, connected: [] })).toBeUndefined();
  });
});

describe("discoverOpenCode", () => {
  it("reports unavailable when the binary is missing", async () => {
    const info = await discoverOpenCode(
      context({ binaryPath: path.join(root, "missing-opencode") }),
    );
    expect(info.available).toBe(false);
    expect(info.authOk).toBe(false);
    expect(info.warnings[0]).toContain("missing or not executable");
    expect(info.sandboxModes).toEqual([]);
  });

  it("reads version, models, default model and auth from a live server", async () => {
    const fake = new FakeOpenCodeServer({
      version: "1.18.25",
      providers: PROVIDERS,
      agents: [
        { name: "build", mode: "primary" },
        { name: "plan", mode: "primary" },
        { name: "title", mode: "primary", hidden: true },
      ],
    });
    const url = await fake.start();
    try {
      const info = await discoverOpenCode(context({ attachUrl: url }));
      expect(info.available).toBe(true);
      expect(info.version).toBe("1.18.25");
      expect(info.authOk).toBe(true);
      expect(info.defaultModel).toBe("openai/gpt-5.4-mini");
      expect(info.models).toContain("openai/gpt-5.4-mini");
      expect(info.supportedVersionRange).toBe(">=1.18.0 <2.0.0");
      // OpenCode has no sandbox flag; these are the levels the adapter emulates.
      expect(info.sandboxModes).toEqual(["read-only", "workspace-write", "danger-full-access"]);
      expect(info.warnings).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  it("warns when no provider is connected", async () => {
    const fake = new FakeOpenCodeServer({
      providers: { all: PROVIDERS.all, default: PROVIDERS.default, connected: [] },
    });
    const url = await fake.start();
    try {
      const info = await discoverOpenCode(context({ attachUrl: url }));
      expect(info.authOk).toBe(false);
      expect(info.warnings.join(" ")).toContain("no provider is connected");
    } finally {
      await fake.stop();
    }
  });

  it("warns when the server version drifts from the tested one", async () => {
    const fake = new FakeOpenCodeServer({ version: "1.19.4", providers: PROVIDERS });
    const url = await fake.start();
    try {
      const info = await discoverOpenCode(context({ attachUrl: url }));
      expect(info.warnings.join(" ")).toContain("differs from the tested version 1.18.25");
    } finally {
      await fake.stop();
    }
  });

  it("warns when the server is outside the contract-tested range", async () => {
    const fake = new FakeOpenCodeServer({ version: "2.3.0", providers: PROVIDERS });
    const url = await fake.start();
    try {
      const info = await discoverOpenCode(context({ attachUrl: url }));
      expect(info.warnings.join(" ")).toContain("outside the contract-tested range");
    } finally {
      await fake.stop();
    }
  });

  it("warns when the configured default model is not in the catalogue", async () => {
    const fake = new FakeOpenCodeServer({ providers: PROVIDERS });
    const url = await fake.start();
    try {
      const info = await discoverOpenCode(
        context({ attachUrl: url, defaultModel: "openai/does-not-exist" }),
      );
      expect(info.warnings.join(" ")).toContain("is not in the provider catalogue");
    } finally {
      await fake.stop();
    }
  });

  it("falls back to `opencode models` when the server cannot be interrogated", async () => {
    // The fake binary serves /global/health but not /provider, exactly like a
    // server whose API surface moved.
    const info = await discoverOpenCode(context({ env: { FAKE_MODELS: "openai/gpt-5.4-mini" } }));
    expect(info.available).toBe(true);
    expect(info.models).toEqual(["openai/gpt-5.4-mini"]);
    expect(info.authOk).toBe(false);
  });

  it("does not leave the probe server running", async () => {
    const created = context();
    const info = await discoverOpenCode(created);
    expect(info.available).toBe(true);
    expect(created.manager.servers.size).toBe(0);
  });
});
