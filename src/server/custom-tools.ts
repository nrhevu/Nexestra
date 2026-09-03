import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { HarnessConfig } from "./harness-config.js";
import type { MasterToolContext, ToolDefinition } from "./harness-tool-types.js";

interface CustomToolShape {
  description: string;
  args?: Record<string, unknown> | z.ZodType;
  parameters?: Record<string, unknown>;
  timeoutMs?: number;
  execute: (input: Record<string, unknown>, context: CustomToolExecutionContext) => unknown;
}

interface CustomToolResult {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
}

interface CustomToolExecutionContext {
  agent: string;
  sessionID: string;
  messageID: string;
  runId: string;
  threadId: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export async function loadCustomTools(
  config: HarnessConfig,
  context: MasterToolContext,
): Promise<{ tools: ToolDefinition[]; warnings: string[] }> {
  const tools: ToolDefinition[] = [];
  const warnings: string[] = [];
  const { directories, allowedRoots } = await customToolLocations(config, context);
  for (const directory of directories) {
    for (const file of await moduleFiles(directory, allowedRoots)) {
      try {
        const loaded = (await withTimeout(
          import(`${pathToFileURL(file).href}?nexestra=${(await lstat(file)).mtimeMs}`),
          5_000,
          "Custom tool module took too long to load.",
        )) as Record<string, unknown>;
        const baseName = sanitizeName(basename(file, extname(file)));
        for (const [exportName, value] of Object.entries(loaded)) {
          if (!isCustomTool(value)) continue;
          const name =
            exportName === "default" ? baseName : `${baseName}_${sanitizeName(exportName)}`;
          tools.push(toToolDefinition(name, value, context));
        }
      } catch {
        warnings.push(`Could not load custom tool ${basename(file)}.`);
      }
    }
  }
  return { tools, warnings };
}

async function customToolLocations(
  config: HarnessConfig,
  context: MasterToolContext,
): Promise<{ directories: string[]; allowedRoots: string[] }> {
  const env = context.env ?? process.env;
  const home = env.HOME || homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const requested = [
    join(context.workspacePath, ".opencode", "tool"),
    join(context.workspacePath, ".opencode", "tools"),
    join(context.workspacePath, ".nexestra", "tool"),
    join(context.workspacePath, ".nexestra", "tools"),
    join(xdg, "opencode", "tool"),
    join(xdg, "opencode", "tools"),
    ...config.customTools.directories.map((path) =>
      isAbsolute(path) ? path : resolve(context.workspacePath, path),
    ),
  ];
  const directories = [...new Set(requested)].filter((path) => {
    if (path.startsWith(`${context.workspacePath}${sep}`)) return true;
    return path.startsWith(`${home}${sep}`);
  });
  const allowedRoots = await Promise.all(
    [context.workspacePath, home].map((path) => realpath(path).catch(() => resolve(path))),
  );
  return { directories, allowedRoots };
}

async function moduleFiles(directory: string, allowedRoots: string[]): Promise<string[]> {
  try {
    const resolved = await realpath(directory);
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`))) {
      return [];
    }
    const entries = await readdir(resolved, { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && [".js", ".mjs", ".cjs", ".ts"].includes(extname(entry.name)),
      )
      .slice(0, 100)
      .map((entry) => join(resolved, entry.name));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

function toToolDefinition(
  name: string,
  custom: CustomToolShape,
  baseContext: MasterToolContext,
): ToolDefinition {
  const argsSchema = customArgsSchema(custom.args);
  const parameters = custom.parameters ?? schemaToJson(argsSchema) ?? emptyObjectSchema();
  return {
    type: "function",
    name,
    description: custom.description.slice(0, 2_000),
    parameters,
    permission: "external",
    parse: async (input) => {
      const parsed = argsSchema ? await argsSchema.parseAsync(input) : input;
      if (!isRecord(parsed)) throw new Error("Custom tool arguments must be an object.");
      return parsed;
    },
    execute: async (input) => {
      const timeoutMs = Math.min(Math.max(custom.timeoutMs ?? 30_000, 1_000), 120_000);
      const controller = new AbortController();
      try {
        const output = await withTimeout(
          Promise.resolve(
            custom.execute(input, {
              agent: baseContext.agent.handle,
              sessionID: baseContext.runId,
              messageID: baseContext.messageId ?? baseContext.runId,
              runId: baseContext.runId,
              threadId: baseContext.threadId,
              directory: baseContext.workspacePath,
              worktree: baseContext.workspacePath,
              abort: controller.signal,
              metadata: () => undefined,
              ask: async () => undefined,
            }),
          ),
          timeoutMs,
          `Custom tool ${name} timed out.`,
          controller,
        );
        if (typeof output === "string") return output;
        if (isCustomToolResult(output)) return output.output;
        return JSON.stringify(output, null, 2);
      } finally {
        controller.abort();
      }
    },
  };
}

function customArgsSchema(args: CustomToolShape["args"]): z.ZodType | undefined {
  if (!args) return undefined;
  if (isZodType(args)) return args;
  const entries = Object.entries(args);
  if (!entries.every(([, value]) => isZodType(value))) return undefined;
  return z.object(args as z.ZodRawShape);
}

function schemaToJson(schema: z.ZodType | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isZodType(value: unknown): value is z.ZodType {
  return isRecord(value) && "_zod" in value;
}

function isCustomToolResult(value: unknown): value is CustomToolResult {
  return isRecord(value) && typeof value.output === "string";
}

function isCustomTool(value: unknown): value is CustomToolShape {
  return (
    isRecord(value) &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    typeof value.execute === "function" &&
    (value.timeoutMs === undefined || typeof value.timeoutMs === "number") &&
    (value.parameters === undefined || isRecord(value.parameters))
  );
}

function sanitizeName(value: string): string {
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (name || "tool").slice(0, 64);
}

function emptyObjectSchema(): Record<string, unknown> {
  return { type: "object", properties: {}, additionalProperties: true };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(message));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
