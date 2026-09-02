/**
 * `discover()` — is Codex usable on this machine, and is it the version this
 * adapter was contract-tested against?
 *
 * `codex exec --json` has no published schema (`docs/harness-protocols.md` §4),
 * so a version drift is the single biggest risk to the parser: it is reported
 * as a warning rather than swallowed.
 */
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessInfo } from "@nexestra/core";
import { execa } from "execa";
import {
  CODEX_SANDBOX_MODES,
  MAX_CODEX_VERSION_EXCLUSIVE,
  MIN_CODEX_VERSION,
  type ResolvedCodexOptions,
  SUPPORTED_CODEX_RANGE,
  TESTED_CODEX_VERSION,
} from "./options.js";

const BINARY_NAME = process.platform === "win32" ? "codex.exe" : "codex";

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
 * Locate the `codex` binary: explicit override first, then `PATH`, then a few
 * well known install locations (`~/.local/bin` is where the installer puts it
 * and it is often missing from a non-login shell's PATH).
 */
export async function findCodexBinary(options: ResolvedCodexOptions): Promise<string | undefined> {
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

/** `codex-cli 0.148.0` → `0.148.0`. */
export function parseCodexVersion(output: string): string | undefined {
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
export function isSupportedCodexVersion(version: string): boolean {
  return (
    compareVersions(version, MIN_CODEX_VERSION) >= 0 &&
    compareVersions(version, MAX_CODEX_VERSION_EXCLUSIVE) < 0
  );
}

async function runCodex(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa(binary, args, {
    reject: false,
    stdin: "ignore",
    timeout: 20_000,
    env,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
  };
}

export async function discoverCodex(options: ResolvedCodexOptions): Promise<HarnessInfo> {
  const detectedAt = new Date().toISOString();
  const warnings: string[] = [];
  const env = { ...process.env, ...options.env } as Record<string, string>;

  const binaryPath = await findCodexBinary(options);
  if (!binaryPath) {
    return {
      id: "codex",
      available: false,
      supportedVersionRange: SUPPORTED_CODEX_RANGE,
      models: [...options.models],
      defaultModel: options.defaultModel,
      sandboxModes: [],
      authOk: false,
      warnings: [
        options.binaryPath
          ? `configured codex binary "${options.binaryPath}" is missing or not executable`
          : "codex binary not found on PATH",
      ],
      detectedAt,
    };
  }

  const versionResult = await runCodex(binaryPath, ["--version"], env);
  const version = parseCodexVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (!version) {
    warnings.push(
      `could not parse a version out of \`codex --version\` (${versionResult.stdout.trim() || "no output"})`,
    );
  } else if (version !== TESTED_CODEX_VERSION) {
    const supported = isSupportedCodexVersion(version);
    warnings.push(
      supported
        ? `codex ${version} differs from the tested version ${TESTED_CODEX_VERSION}; ` +
            "`codex exec --json` has no published schema, so the event stream may have changed"
        : `codex ${version} is outside the contract-tested range ${SUPPORTED_CODEX_RANGE}; ` +
            "the JSONL parser may drop or mis-map events",
    );
  }

  const loginResult = await runCodex(binaryPath, ["login", "status"], env);
  const loginText = `${loginResult.stdout}\n${loginResult.stderr}`.trim();
  const authOk = loginResult.exitCode === 0 && /logged in/i.test(loginText);
  if (!authOk) {
    warnings.push(
      `codex is not logged in (\`codex login status\` exited ${loginResult.exitCode}` +
        `${loginText ? `: ${loginText.split("\n")[0]}` : ""}). Run \`codex login\`.`,
    );
  }

  return {
    id: "codex",
    available: versionResult.exitCode === 0,
    binaryPath,
    version,
    supportedVersionRange: SUPPORTED_CODEX_RANGE,
    models: [...options.models],
    defaultModel: options.defaultModel,
    sandboxModes: [...CODEX_SANDBOX_MODES],
    authOk,
    warnings,
    detectedAt,
  };
}
