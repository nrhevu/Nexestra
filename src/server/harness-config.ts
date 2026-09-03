import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { type ToolPermission, ToolPermissionSchema } from "../shared/contracts.js";

const EnvironmentSchema = z.record(z.string(), z.string().max(8_000)).default({});
const McpTimeoutValueSchema = z
  .number()
  .int()
  .min(1_000)
  .max(12 * 60 * 60_000);
const McpTimeoutOverrideSchema = z.union([
  McpTimeoutValueSchema,
  z.object({
    startup: McpTimeoutValueSchema.optional(),
    catalog: McpTimeoutValueSchema.optional(),
    execution: McpTimeoutValueSchema.optional(),
  }),
]);

const LocalMcpServerSchema = z.object({
  type: z.literal("local"),
  command: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  cwd: z.string().max(2_000).optional(),
  environment: EnvironmentSchema,
  disabled: z.boolean().default(false),
  codemode: z.boolean().optional(),
  timeout: McpTimeoutOverrideSchema.optional(),
});

const RemoteMcpServerSchema = z.object({
  type: z.literal("remote"),
  url: z.string().url().max(4_000),
  headers: EnvironmentSchema,
  disabled: z.boolean().default(false),
  codemode: z.boolean().optional(),
  oauth: z.union([z.literal(false), z.record(z.string(), z.unknown())]).optional(),
  timeout: McpTimeoutOverrideSchema.optional(),
});

export const HarnessConfigSchema = z.object({
  permission: z.record(z.string().max(100), ToolPermissionSchema).default({}),
  ignore: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  customTools: z
    .object({ directories: z.array(z.string().min(1).max(2_000)).max(20).default([]) })
    .default({ directories: [] }),
  websearch: z
    .object({ provider: z.enum(["exa", "parallel"]).default("exa") })
    .default({ provider: "exa" }),
  mcp: z
    .object({
      timeout: z
        .object({
          startup: McpTimeoutValueSchema.default(30_000),
          catalog: McpTimeoutValueSchema.default(30_000),
          execution: McpTimeoutValueSchema.default(12 * 60 * 60_000),
        })
        .default({ startup: 30_000, catalog: 30_000, execution: 12 * 60 * 60_000 }),
      servers: z
        .record(
          z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
          z.discriminatedUnion("type", [LocalMcpServerSchema, RemoteMcpServerSchema]),
        )
        .default({}),
    })
    .default({
      timeout: { startup: 30_000, catalog: 30_000, execution: 12 * 60 * 60_000 },
      servers: {},
    }),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type McpServerConfig = HarnessConfig["mcp"]["servers"][string];

export async function loadHarnessConfig(workspacePath: string): Promise<HarnessConfig> {
  const file = resolve(workspacePath, "nexestra.config.json");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return HarnessConfigSchema.parse({});
    throw new Error("Unable to read nexestra.config.json.", { cause: error });
  }
  if (Buffer.byteLength(source) > 256 * 1024) {
    throw new Error("nexestra.config.json is larger than 256 KiB.");
  }
  try {
    return HarnessConfigSchema.parse(JSON.parse(stripJsonComments(source)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid configuration.";
    throw new Error(`Invalid nexestra.config.json: ${message}`);
  }
}

export function configuredPermission(
  rules: Record<string, ToolPermission>,
  toolName: string,
): ToolPermission | undefined {
  let result: ToolPermission | undefined;
  for (const [pattern, permission] of Object.entries(rules)) {
    if (pattern === toolName) {
      result = permission;
      continue;
    }
    if (!pattern.includes("*")) continue;
    const expression = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    if (expression.test(toolName)) result = permission;
  }
  return result;
}

export function mergePermissions(
  agentPermission: ToolPermission,
  configured: ToolPermission | undefined,
): ToolPermission {
  if (!configured) return agentPermission;
  const rank: Record<ToolPermission, number> = { allow: 0, ask: 1, deny: 2 };
  return rank[configured] > rank[agentPermission] ? configured : agentPermission;
}

export function expandEnvironmentValue(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\{env:([A-Z_][A-Z0-9_]*)\}|\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, a, b) => {
    const name = (a || b) as string;
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`Environment variable ${name} is not set.`);
    return resolved;
  });
}

function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
