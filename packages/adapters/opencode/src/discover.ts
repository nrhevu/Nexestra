/**
 * `discover()` — is OpenCode usable on this machine, is it the version this
 * adapter was contract-tested against, and is any provider actually connected?
 *
 * The last question matters more than it looks: the default model on the
 * recording machine was `9router/…` pointing at a local proxy that was not
 * running, and a prompt against it returned HTTP 200 and then failed after five
 * retries and 64 s (`docs/harness-protocols.md` §4.5). Nexestra must always
 * send an explicit `provider/model` and validate it against `connected[]`.
 */
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessInfo } from "@nexestra/core";
import { execa } from "execa";
import {
  MAX_OPENCODE_VERSION_EXCLUSIVE,
  MIN_OPENCODE_VERSION,
  OPENCODE_SANDBOX_MODES,
  type ResolvedOpenCodeOptions,
  SUPPORTED_OPENCODE_RANGE,
  TESTED_OPENCODE_VERSION,
} from "./options.js";
import type { OpenCodeServerManager } from "./server.js";
import type { OpenCodeAgent, OpenCodeProviderList } from "./types.js";

const BINARY_NAME = process.platform === "win32" ? "opencode.exe" : "opencode";

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the `opencode` binary: explicit override first, then `PATH`, then the
 * install locations (`~/.opencode/bin` is where the installer puts it and it is
 * routinely missing from a non-login shell's PATH).
 */
export async function findOpenCodeBinary(
  options: Pick<ResolvedOpenCodeOptions, "binaryPath" | "extraSearchPaths">,
): Promise<string | undefined> {
  if (options.binaryPath) {
    return (await isExecutable(options.binaryPath)) ? options.binaryPath : undefined;
  }
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...options.extraSearchPaths]) {
    const candidate = path.join(dir, BINARY_NAME);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** `1.18.25` out of `opencode --version` (which prints the bare version). */
export function parseOpenCodeVersion(output: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  return match?.[0];
}

function versionTuple(version: string): [number, number, number] {
  const core = version.split(/[-+]/)[0] ?? version;
  const parts = core.split(".");
  return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
}

function compareVersions(a: string, b: string): number {
  const left = versionTuple(a);
  const right = versionTuple(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** `>=MIN <MAX` membership, without pulling in a semver dependency. */
export function isSupportedOpenCodeVersion(version: string): boolean {
  return (
    compareVersions(version, MIN_OPENCODE_VERSION) >= 0 &&
    compareVersions(version, MAX_OPENCODE_VERSION_EXCLUSIVE) < 0
  );
}

/** `provider/model` ids out of `GET /provider`, connected providers first. */
export function modelsFromProviders(providers: OpenCodeProviderList): string[] {
  const connected = new Set(providers.connected ?? []);
  const first: string[] = [];
  const rest: string[] = [];
  for (const provider of providers.all ?? []) {
    for (const modelId of Object.keys(provider.models ?? {})) {
      const id = `${provider.id}/${modelId}`;
      (connected.has(provider.id) ? first : rest).push(id);
    }
  }
  first.sort();
  rest.sort();
  return [...first, ...rest];
}

/** Default `provider/model`, preferring a provider that is actually connected. */
export function defaultModelFrom(providers: OpenCodeProviderList): string | undefined {
  const defaults = providers.default ?? {};
  for (const providerId of providers.connected ?? []) {
    const model = defaults[providerId];
    if (model) return `${providerId}/${model}`;
  }
  const first = Object.entries(defaults)[0];
  return first ? `${first[0]}/${first[1]}` : undefined;
}

async function runOpenCode(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa(binary, args, {
    reject: false,
    stdin: "ignore",
    timeout: timeoutMs,
    env,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
  };
}

export interface DiscoverOpenCodeContext {
  options: ResolvedOpenCodeOptions;
  /** Reused so a server already running for `directory` is not restarted. */
  manager: OpenCodeServerManager;
  /** Workspace the probe server is rooted at. Defaults to `process.cwd()`. */
  directory?: string;
}

export async function discoverOpenCode(context: DiscoverOpenCodeContext): Promise<HarnessInfo> {
  const { options, manager } = context;
  const directory = context.directory ?? process.cwd();
  const detectedAt = new Date().toISOString();
  const warnings: string[] = [];
  const env = { ...process.env, ...options.env } as Record<string, string>;

  const binaryPath = await findOpenCodeBinary(options);
  if (!binaryPath && !options.attachUrl) {
    return {
      id: "opencode",
      available: false,
      supportedVersionRange: SUPPORTED_OPENCODE_RANGE,
      models: [...(options.models ?? [])],
      defaultModel: options.defaultModel,
      sandboxModes: [],
      authOk: false,
      warnings: [
        options.binaryPath
          ? `configured opencode binary "${options.binaryPath}" is missing or not executable`
          : "opencode binary not found on PATH",
      ],
      detectedAt,
    };
  }

  let version: string | undefined;
  if (binaryPath) {
    const result = await runOpenCode(binaryPath, ["--version"], env, 20_000);
    version = parseOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
  }

  let models: string[] = [];
  let defaultModel = options.defaultModel;
  let agents: string[] = [];
  let authOk = false;
  let serverOk = false;

  // A short-lived server is the only way to enumerate providers *and* agents,
  // and it doubles as a smoke test of the exact launch path `run()` uses.
  const preExisting = manager.get(directory) !== undefined;
  try {
    const server = await manager.ensure(directory);
    serverOk = true;
    if (server.version) version = server.version;
    const [providers, agentList] = await Promise.all([
      server.client.providers().catch(() => undefined),
      server.client.agents().catch((): OpenCodeAgent[] => []),
    ]);
    if (providers) {
      models = modelsFromProviders(providers);
      defaultModel ??= defaultModelFrom(providers);
      authOk = (providers.connected ?? []).length > 0;
      if (!authOk) {
        warnings.push(
          "no provider is connected (`GET /provider` → `connected: []`); run `opencode auth login`",
        );
      }
    }
    agents = agentList
      .filter((agent) => agent.hidden !== true)
      .map((agent) => agent.name)
      .sort();
    if (!preExisting) await manager.dispose(directory);
  } catch (error) {
    warnings.push(
      `could not start \`opencode serve\` in ${directory}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Fallback: the CLI can still list models without a server.
  if (models.length === 0 && binaryPath) {
    const listed = await runOpenCode(binaryPath, ["models"], env, 30_000);
    if (listed.exitCode === 0) {
      models = listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("/"));
    }
  }
  if (options.models) models = [...options.models];

  if (!version) {
    warnings.push("could not read the opencode version (`opencode --version` produced no output)");
  } else if (version !== TESTED_OPENCODE_VERSION) {
    warnings.push(
      isSupportedOpenCodeVersion(version)
        ? `opencode ${version} differs from the tested version ${TESTED_OPENCODE_VERSION}; ` +
            "the v1 event union grows every release, so new part or event types may be dropped"
        : `opencode ${version} is outside the contract-tested range ${SUPPORTED_OPENCODE_RANGE}; ` +
            "the SSE mapper may drop or mis-map events",
    );
  }
  if (defaultModel && models.length > 0 && !models.includes(defaultModel)) {
    warnings.push(
      `the default model "${defaultModel}" is not in the provider catalogue; ` +
        "runs will fail with an APIError after five retries",
    );
  }
  if (agents.length > 0 && !agents.includes(options.agent)) {
    warnings.push(`agent "${options.agent}" is not configured on this machine`);
  }

  return {
    id: "opencode",
    available: serverOk || (binaryPath !== undefined && version !== undefined),
    ...(binaryPath ? { binaryPath } : {}),
    ...(version ? { version } : {}),
    supportedVersionRange: SUPPORTED_OPENCODE_RANGE,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    // OpenCode has no sandbox flag; these are the levels the adapter emulates
    // with a per-session permission ruleset (`permission.ts`).
    sandboxModes: [...OPENCODE_SANDBOX_MODES],
    authOk,
    warnings,
    detectedAt,
  };
}
