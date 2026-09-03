import {
  glob as fsGlob,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HarnessToolName, MasterAgent, ToolCall } from "../shared/contracts.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

export interface MasterToolHooks {
  update(toolCall: ToolCall): Promise<void>;
  requestApproval(toolCall: ToolCall): Promise<boolean>;
}

export interface MasterToolContext {
  agent: MasterAgent;
  runId: string;
  threadId: string;
  workspacePath: string;
  dataPath: string;
  hooks?: MasterToolHooks;
  env?: NodeJS.ProcessEnv;
  redact(value: string): string;
}

export interface HarnessToolRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderToolDefinition {
  type: "function";
  name: HarnessToolName;
  description: string;
  parameters: Record<string, unknown>;
}

interface ToolDefinition extends ProviderToolDefinition {
  permission: "read" | "edit" | "bash";
  schema: z.ZodType<Record<string, unknown>>;
  execute(input: Record<string, unknown>, context: MasterToolContext): Promise<string>;
}

const optionalPath = z.string().trim().min(1).max(2_000).default(".");

const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    name: "list",
    description: "List files and directories inside the repository.",
    permission: "read",
    parameters: objectSchema(
      {
        path: stringProperty("Directory relative to the repository root."),
        depth: integerProperty(1, 5),
      },
      [],
    ),
    schema: z.object({ path: optionalPath, depth: z.number().int().min(1).max(5).default(2) }),
    execute: listTool,
  },
  {
    type: "function",
    name: "glob",
    description: "Find repository files whose relative paths match a glob pattern.",
    permission: "read",
    parameters: objectSchema(
      {
        pattern: stringProperty("Glob such as src/**/*.ts."),
        path: stringProperty("Directory relative to the repository root."),
      },
      ["pattern"],
    ),
    schema: z.object({ pattern: z.string().trim().min(1).max(500), path: optionalPath }),
    execute: globTool,
  },
  {
    type: "function",
    name: "grep",
    description: "Search text files in the repository with a regular expression.",
    permission: "read",
    parameters: objectSchema(
      {
        query: stringProperty("JavaScript regular expression, without delimiters."),
        path: stringProperty("File or directory relative to the repository root."),
        pattern: stringProperty("Optional glob limiting files, for example **/*.ts."),
      },
      ["query"],
    ),
    schema: z.object({
      query: z.string().min(1).max(500),
      path: optionalPath,
      pattern: z.string().trim().min(1).max(500).default("**/*"),
    }),
    execute: grepTool,
  },
  {
    type: "function",
    name: "read",
    description: "Read a UTF-8 text file with line numbers.",
    permission: "read",
    parameters: objectSchema(
      {
        path: stringProperty("File relative to the repository root."),
        offset: integerProperty(1, 1_000_000_000),
        limit: integerProperty(1, 1_000),
      },
      ["path"],
    ),
    schema: z.object({
      path: z.string().trim().min(1).max(2_000),
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(1_000).default(200),
    }),
    execute: readTool,
  },
  {
    type: "function",
    name: "edit",
    description: "Replace exact text in an existing repository file.",
    permission: "edit",
    parameters: objectSchema(
      {
        path: stringProperty("File relative to the repository root."),
        old_text: stringProperty("Exact text to replace."),
        new_text: stringProperty("Replacement text."),
        replace_all: { type: "boolean", description: "Replace every match instead of one." },
      },
      ["path", "old_text", "new_text"],
    ),
    schema: z.object({
      path: z.string().trim().min(1).max(2_000),
      old_text: z.string().min(1).max(MAX_FILE_BYTES),
      new_text: z.string().max(MAX_FILE_BYTES),
      replace_all: z.boolean().default(false),
    }),
    execute: editTool,
  },
  {
    type: "function",
    name: "write",
    description: "Create or replace a UTF-8 file inside the repository.",
    permission: "edit",
    parameters: objectSchema(
      {
        path: stringProperty("File relative to the repository root."),
        content: stringProperty("Complete file contents."),
      },
      ["path", "content"],
    ),
    schema: z.object({
      path: z.string().trim().min(1).max(2_000),
      content: z.string().max(MAX_FILE_BYTES),
    }),
    execute: writeTool,
  },
  {
    type: "function",
    name: "bash",
    description: "Run a shell command in the repository with bounded time and output.",
    permission: "bash",
    parameters: objectSchema(
      {
        command: stringProperty("Shell command to run from the repository root."),
        timeout_ms: integerProperty(1_000, 120_000),
      },
      ["command"],
    ),
    schema: z.object({
      command: z.string().trim().min(1).max(20_000),
      timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
    }),
    execute: bashTool,
  },
];

const definitionsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

export function providerToolDefinitions(): ProviderToolDefinition[] {
  return toolDefinitions.map(({ type, name, description, parameters }) => ({
    type,
    name,
    description,
    parameters,
  }));
}

export async function executeMasterTool(
  request: HarnessToolRequest,
  context: MasterToolContext,
): Promise<string> {
  const definition = definitionsByName.get(request.name as HarnessToolName);
  if (!definition) return `Tool error: Unknown tool ${request.name}.`;

  let input: Record<string, unknown>;
  try {
    const parsed = request.arguments.trim() ? JSON.parse(request.arguments) : {};
    input = definition.schema.parse(parsed);
  } catch (error) {
    return `Tool error: ${formatValidationError(error)}`;
  }

  const now = new Date().toISOString();
  const policy = context.agent.permissions[definition.permission];
  let toolCall: ToolCall = {
    id: crypto.randomUUID(),
    runId: context.runId,
    threadId: context.threadId,
    agentId: context.agent.id,
    name: definition.name,
    permission: definition.permission,
    status: policy === "ask" ? "waiting_approval" : policy === "allow" ? "running" : "denied",
    input: context.redact(toolInputSummary(definition.name, input)).slice(0, 4_000),
    createdAt: now,
    updatedAt: now,
  };

  if (policy === "deny") {
    toolCall = { ...toolCall, summary: "Blocked by the agent permission policy." };
    await context.hooks?.update(toolCall);
    return `Permission denied: ${definition.permission} tools are disabled for this agent.`;
  }

  if (policy === "ask") {
    const approved = context.hooks ? await context.hooks.requestApproval(toolCall) : false;
    if (!approved) {
      toolCall = {
        ...toolCall,
        status: "denied",
        summary: "Denied by the user.",
        updatedAt: new Date().toISOString(),
      };
      await context.hooks?.update(toolCall);
      return "Permission denied by the user.";
    }
    toolCall = { ...toolCall, status: "running", updatedAt: new Date().toISOString() };
    await context.hooks?.update(toolCall);
  } else {
    await context.hooks?.update(toolCall);
  }

  try {
    const output = limitOutput(context.redact(await definition.execute(input, context)));
    toolCall = {
      ...toolCall,
      status: "completed",
      summary: outputSummary(definition.name, output),
      updatedAt: new Date().toISOString(),
    };
    await context.hooks?.update(toolCall);
    return output;
  } catch (error) {
    const message = context.redact(
      error instanceof Error ? error.message : "Tool execution failed.",
    );
    toolCall = {
      ...toolCall,
      status: "failed",
      error: message.slice(0, 2_000),
      updatedAt: new Date().toISOString(),
    };
    await context.hooks?.update(toolCall);
    return `Tool error: ${message}`;
  }
}

async function listTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const maximumDepth = input.depth as number;
  const start = await securePath(context, requestedPath, "read");
  if (!(await stat(start)).isDirectory()) throw new Error(`${requestedPath} is not a directory.`);
  const lines: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (lines.length >= MAX_ENTRIES) return;
      if (isIgnoredEntry(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const display = relative(context.workspacePath, absolute) || ".";
      lines.push(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"} ${display}`);
      if (entry.isDirectory() && depth < maximumDepth) await visit(absolute, depth + 1);
    }
  }

  await visit(start, 1);
  if (lines.length === MAX_ENTRIES) lines.push("… result limit reached");
  return lines.join("\n") || "Directory is empty.";
}

async function globTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const pattern = validateGlob(input.pattern as string);
  const base = await securePath(context, input.path as string, "read");
  if (!(await stat(base)).isDirectory()) throw new Error("Glob path must be a directory.");
  const results: string[] = [];
  for await (const entry of fsGlob(pattern, { cwd: base, exclude: ignoredGlob })) {
    if (results.length >= MAX_ENTRIES) break;
    const absolute = await securePath(
      context,
      relative(context.workspacePath, resolve(base, entry)),
      "read",
    );
    const info = await lstat(absolute);
    if (info.isFile()) results.push(relative(context.workspacePath, absolute));
  }
  results.sort();
  if (results.length === MAX_ENTRIES) results.push("… result limit reached");
  return results.join("\n") || "No files matched.";
}

async function grepTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const target = await securePath(context, requestedPath, "read");
  const pattern = validateGlob(input.pattern as string);
  const binary = await findExecutable("rg", context.env);
  if (!binary) throw new Error("The grep tool requires ripgrep (rg) in PATH.");
  const result = await runCommand(
    binary,
    [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-filesize",
      "1M",
      "--glob",
      pattern,
      "--glob",
      "!.git/**",
      "--glob",
      "!.nexestra/**",
      "--glob",
      "!node_modules/**",
      "--",
      input.query as string,
      relative(context.workspacePath, target) || ".",
    ],
    {
      cwd: context.workspacePath,
      timeoutMs: 10_000,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
      env: safeProcessEnv(context.env),
    },
  );
  if (result.exitCode === 1) return "No matches found.";
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "ripgrep failed.");
  return result.stdout.trimEnd();
}

async function readTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const file = await securePath(context, requestedPath, "read");
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${requestedPath} is not a file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error("File is larger than 1 MiB.");
  const content = await readFile(file, "utf8");
  if (content.includes("\0")) throw new Error("Binary files cannot be read.");
  const offset = input.offset as number;
  const limit = input.limit as number;
  return content
    .split("\n")
    .slice(offset - 1, offset - 1 + limit)
    .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
    .join("\n");
}

async function editTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const file = await securePath(context, requestedPath, "write");
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${requestedPath} is not a file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error("File is larger than 1 MiB.");
  const content = await readFile(file, "utf8");
  if (content.includes("\0")) throw new Error("Binary files cannot be edited.");
  const oldText = input.old_text as string;
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw new Error("old_text was not found.");
  if (!input.replace_all && occurrences !== 1) {
    throw new Error(
      `old_text matched ${occurrences} times; provide more context or use replace_all.`,
    );
  }
  const updated = input.replace_all
    ? content.replaceAll(oldText, input.new_text as string)
    : content.replace(oldText, input.new_text as string);
  if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
    throw new Error("Edited file would exceed 1 MiB.");
  await writeAtomic(file, updated, info.mode);
  return `Updated ${requestedPath} (${input.replace_all ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"}).`;
}

async function writeTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const file = await securePath(context, requestedPath, "write", true);
  const content = input.content as string;
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error("File would exceed 1 MiB.");
  await mkdir(dirname(file), { recursive: true });
  const mode = await stat(file)
    .then((info) => info.mode)
    .catch(() => undefined);
  await writeAtomic(file, content, mode);
  return `Wrote ${requestedPath} (${Buffer.byteLength(content)} bytes).`;
}

async function bashTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const env = safeProcessEnv(context.env);
  delete env.CODEX_HOME;
  delete env.OPENCODE_CONFIG;
  const result = await runCommand("/bin/bash", ["-lc", input.command as string], {
    cwd: context.workspacePath,
    timeoutMs: input.timeout_ms as number,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    env,
  });
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  return `${output}${output ? "\n" : ""}[exit ${result.exitCode}]`;
}

async function securePath(
  context: MasterToolContext,
  requestedPath: string,
  operation: "read" | "write",
  allowMissing = false,
): Promise<string> {
  if (isAbsolute(requestedPath)) throw new Error("Paths must be relative to the repository root.");
  const workspace = await realpath(context.workspacePath);
  const target = resolve(workspace, requestedPath);
  if (!isWithin(workspace, target)) throw new Error("Path escapes the repository root.");
  if (isSensitivePath(context, target))
    throw new Error("Nexestra credentials and auth files are protected.");

  try {
    const resolved = await realpath(target);
    if (!isWithin(workspace, resolved))
      throw new Error("Path resolves outside the repository root.");
    if (isSensitivePath(context, resolved)) {
      throw new Error("Nexestra credentials and auth files are protected.");
    }
    return resolved;
  } catch (error) {
    if (!allowMissing || !isNodeError(error, "ENOENT")) throw error;
  }

  let ancestor = dirname(target);
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      if (!isWithin(workspace, resolvedAncestor)) {
        throw new Error("Path resolves outside the repository root.");
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (operation === "read") throw new Error(`${requestedPath} does not exist.`);
  return target;
}

function isSensitivePath(context: MasterToolContext, target: string): boolean {
  if (target === resolve(context.dataPath, "credentials.json")) return true;
  const name = basename(target).toLowerCase();
  return name === "auth.json" || name === "credentials.json";
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function validateGlob(pattern: string): string {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error("Glob patterns must stay inside the repository root.");
  }
  return pattern;
}

function ignoredGlob(path: string): boolean {
  return path.split(/[\\/]/).some(isIgnoredEntry);
}

function isIgnoredEntry(name: string): boolean {
  return name === ".git" || name === ".nexestra" || name === "node_modules";
}

async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode });
  await rename(temporary, file);
}

function toolInputSummary(name: HarnessToolName, input: Record<string, unknown>): string {
  if (name === "write") {
    return compactSummary({
      path: input.path,
      content_preview: previewText(input.content as string, 2_400),
      bytes: Buffer.byteLength(input.content as string),
    });
  }
  if (name === "edit") {
    return compactSummary({
      path: input.path,
      old_text_preview: previewText(input.old_text as string, 1_200),
      new_text_preview: previewText(input.new_text as string, 1_200),
      replace_all: input.replace_all,
    });
  }
  return compactSummary(input);
}

function previewText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}\n… preview truncated` : value;
}

function compactSummary(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 4_000 ? `${serialized.slice(0, 3_980)}… truncated` : serialized;
}

function outputSummary(name: HarnessToolName, output: string): string {
  if (name === "read" || name === "grep" || name === "glob" || name === "list") {
    const lines = output ? output.split("\n").length : 0;
    return `Returned ${lines} line${lines === 1 ? "" : "s"}.`;
  }
  if (name === "bash") return output.split("\n").at(-1)?.slice(0, 200) || "Command finished.";
  return output.slice(0, 500);
}

function limitOutput(output: string): string {
  const bytes = Buffer.byteLength(output);
  if (bytes <= MAX_TOOL_OUTPUT_BYTES) return output;
  return `${Buffer.from(output).subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8")}\n… output truncated`;
}

function formatValidationError(error: unknown): string {
  if (error instanceof SyntaxError) return "Arguments must be valid JSON.";
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid arguments.";
  return error instanceof Error ? error.message : "Invalid arguments.";
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function integerProperty(minimum: number, maximum: number): Record<string, unknown> {
  return { type: "integer", minimum, maximum };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
