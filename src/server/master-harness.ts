import { lookup } from "node:dns/promises";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HarnessPermissionKey, ToolCall, ToolQuestion } from "../shared/contracts.js";
import { loadCustomTools } from "./custom-tools.js";
import {
  configuredPermission,
  type HarnessConfig,
  loadHarnessConfig,
  mergePermissions,
} from "./harness-config.js";
import type {
  HarnessToolRequest,
  MasterToolContext,
  ProviderToolDefinition,
  ToolDefinition,
} from "./harness-tool-types.js";
import { callRemoteMcpTool, loadMcpTools } from "./mcp-tools.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";
import { discoverSkills, type HarnessSkill, readSkill, skillDescription } from "./skills.js";

export type {
  HarnessToolRequest,
  MasterToolContext,
  MasterToolHooks,
  ProviderToolDefinition,
} from "./harness-tool-types.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

export interface MasterToolSession {
  definitions: ProviderToolDefinition[];
  warnings: string[];
  execute(request: HarnessToolRequest): Promise<string>;
  close(): Promise<void>;
}

export async function createMasterToolSession(
  context: MasterToolContext,
): Promise<MasterToolSession> {
  const config = await loadHarnessConfig(context.workspacePath);
  const skills = await discoverSkills(context);
  const extensionsEnabled =
    context.agent.permissions.external !== "deny" &&
    configuredPermission(config.permission, "__extension__") !== "deny";
  const custom = extensionsEnabled
    ? await loadCustomTools(config, context)
    : { tools: [], warnings: [] };
  const mcp = extensionsEnabled
    ? await loadMcpTools(config, context)
    : { tools: [], warnings: [], close: async () => undefined };
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of builtInTools(config, skills)) definitions.set(tool.name, tool);
  for (const tool of custom.tools) definitions.set(tool.name, tool);
  for (const tool of mcp.tools) definitions.set(tool.name, tool);
  return {
    definitions: [...definitions.values()].map(({ type, name, description, parameters }) => ({
      type,
      name,
      description,
      parameters,
    })),
    warnings: [...custom.warnings, ...mcp.warnings],
    execute: (request) => executeDefinition(request, context, config, definitions),
    close: mcp.close,
  };
}

export async function executeMasterTool(
  request: HarnessToolRequest,
  context: MasterToolContext,
): Promise<string> {
  const session = await createMasterToolSession(context);
  try {
    return await session.execute(request);
  } finally {
    await session.close();
  }
}

function builtInTools(config: HarnessConfig, skills: HarnessSkill[]): ToolDefinition[] {
  let todos: Record<string, unknown>[] = [];
  return [
    zodTool(
      "list",
      "List files and directories inside the repository.",
      "read",
      objectSchema(
        {
          path: stringProperty("Directory relative to the repository root."),
          depth: integerProperty(1, 5),
        },
        [],
      ),
      z.object({ path: optionalPath, depth: z.number().int().min(1).max(5).default(2) }),
      (input, context) => listTool(input, context, config),
    ),
    zodTool(
      "glob",
      "Find repository files whose relative paths match a glob pattern.",
      "read",
      objectSchema(
        {
          pattern: stringProperty("Glob such as src/**/*.ts."),
          path: stringProperty("Directory relative to the repository root."),
        },
        ["pattern"],
      ),
      z.object({ pattern: z.string().trim().min(1).max(500), path: optionalPath }),
      (input, context) => globTool(input, context, config),
    ),
    zodTool(
      "grep",
      "Search text files in the repository with a regular expression.",
      "read",
      objectSchema(
        {
          query: stringProperty("Regular expression, without delimiters."),
          path: stringProperty("File or directory relative to the repository root."),
          pattern: stringProperty("Optional glob limiting files, for example **/*.ts."),
        },
        ["query"],
      ),
      z.object({
        query: z.string().min(1).max(500),
        path: optionalPath,
        pattern: z.string().trim().min(1).max(500).default("**/*"),
      }),
      (input, context) => grepTool(input, context, config),
    ),
    zodTool(
      "read",
      "Read a UTF-8 text file with line numbers.",
      "read",
      objectSchema(
        {
          path: stringProperty("File relative to the repository root."),
          offset: integerProperty(1, 1_000_000_000),
          limit: integerProperty(1, 1_000),
        },
        ["path"],
      ),
      z.object({
        path: z.string().trim().min(1).max(2_000),
        offset: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(1_000).default(200),
      }),
      readTool,
    ),
    zodTool(
      "edit",
      "Replace exact text in an existing repository file.",
      "edit",
      objectSchema(
        {
          path: stringProperty("File relative to the repository root."),
          old_text: stringProperty("Exact text to replace."),
          new_text: stringProperty("Replacement text."),
          replace_all: { type: "boolean", description: "Replace every match instead of one." },
        },
        ["path", "old_text", "new_text"],
      ),
      z.object({
        path: z.string().trim().min(1).max(2_000),
        old_text: z.string().min(1).max(MAX_FILE_BYTES),
        new_text: z.string().max(MAX_FILE_BYTES),
        replace_all: z.boolean().default(false),
      }),
      editTool,
    ),
    zodTool(
      "write",
      "Create or replace a UTF-8 file inside the repository.",
      "edit",
      objectSchema(
        {
          path: stringProperty("File relative to the repository root."),
          content: stringProperty("Complete file contents."),
        },
        ["path", "content"],
      ),
      z.object({
        path: z.string().trim().min(1).max(2_000),
        content: z.string().max(MAX_FILE_BYTES),
      }),
      writeTool,
    ),
    zodTool(
      "bash",
      "Run a shell command in the repository with bounded time and output.",
      "bash",
      objectSchema(
        {
          command: stringProperty("Shell command to run from the repository root."),
          timeout_ms: integerProperty(1_000, 120_000),
        },
        ["command"],
      ),
      z.object({
        command: z.string().trim().min(1).max(20_000),
        timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
      }),
      bashTool,
    ),
    zodTool(
      "apply_patch",
      "Apply a multi-file patch using Begin Patch, Add/Update/Delete File, and optional Move to markers.",
      "edit",
      objectSchema({ patchText: stringProperty("The complete patch text to apply.") }, [
        "patchText",
      ]),
      z.object({ patchText: z.string().min(1).max(MAX_FILE_BYTES) }),
      applyPatchTool,
    ),
    zodTool(
      "skill",
      skillDescription(skills),
      "skill",
      objectSchema({ name: stringProperty("Installed skill name.") }, ["name"]),
      z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }),
      async (input) => {
        const skill = skills.find((entry) => entry.name === input.name);
        if (!skill) throw new Error(`Skill ${String(input.name)} was not found.`);
        return readSkill(skill);
      },
    ),
    zodTool(
      "todowrite",
      "Replace the current run's todo list. Keep exactly one item in progress while work remains.",
      "todowrite",
      objectSchema(
        {
          todos: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["id", "content", "status", "priority"],
              additionalProperties: false,
            },
          },
        },
        ["todos"],
      ),
      z.object({
        todos: z
          .array(
            z.object({
              id: z.string().trim().min(1).max(100),
              content: z.string().trim().min(1).max(500),
              status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
              priority: z.enum(["high", "medium", "low"]),
            }),
          )
          .max(50)
          .refine(
            (items) => items.filter((item) => item.status === "in_progress").length <= 1,
            "Only one todo may be in progress.",
          ),
      }),
      async (input) => {
        todos = input.todos as Record<string, unknown>[];
        return JSON.stringify(todos, null, 2);
      },
    ),
    zodTool(
      "webfetch",
      "Fetch a public HTTP or HTTPS URL and return it as markdown, text, or HTML.",
      "webfetch",
      objectSchema(
        {
          url: stringProperty("Public URL to fetch."),
          format: { type: "string", enum: ["markdown", "text", "html"] },
          timeout: integerProperty(1, 120),
        },
        ["url"],
      ),
      z.object({
        url: z.string().url().max(4_000),
        format: z.enum(["markdown", "text", "html"]).default("markdown"),
        timeout: z.number().int().min(1).max(120).default(30),
      }),
      webFetchTool,
    ),
    zodTool(
      "websearch",
      `Search the public web with ${config.websearch.provider === "exa" ? "Exa" : "Parallel"}.`,
      "websearch",
      objectSchema(
        {
          query: stringProperty("Web search query."),
          numResults: integerProperty(1, 20),
          type: { type: "string", enum: ["auto", "fast", "deep"] },
          livecrawl: { type: "string", enum: ["fallback", "preferred"] },
          contextMaxCharacters: integerProperty(1_000, 50_000),
        },
        ["query"],
      ),
      z.object({
        query: z.string().trim().min(1).max(500),
        numResults: z.number().int().min(1).max(20).default(8),
        type: z.enum(["auto", "fast", "deep"]).default("auto"),
        livecrawl: z.enum(["fallback", "preferred"]).default("fallback"),
        contextMaxCharacters: z.number().int().min(1_000).max(50_000).default(10_000),
      }),
      (input, context) => webSearchTool(input, context, config),
    ),
    zodTool(
      "question",
      "Ask the local user one to three questions and continue with their answers.",
      "question",
      objectSchema(
        {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                header: { type: "string", maxLength: 30 },
                question: { type: "string", maxLength: 500 },
                multiple: { type: "boolean" },
                options: {
                  type: "array",
                  minItems: 1,
                  maxItems: 12,
                  items: {
                    type: "object",
                    properties: { label: { type: "string" }, description: { type: "string" } },
                    required: ["label", "description"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["header", "question", "options"],
              additionalProperties: false,
            },
          },
        },
        ["questions"],
      ),
      z.object({
        questions: z
          .array(
            z.object({
              header: z.string().trim().min(1).max(30),
              question: z.string().trim().min(1).max(500),
              options: z
                .array(
                  z.object({
                    label: z.string().trim().min(1).max(100),
                    description: z.string().trim().max(300).default(""),
                  }),
                )
                .min(1)
                .max(12),
              multiple: z.boolean().default(false),
            }),
          )
          .min(1)
          .max(3),
      }),
      questionTool,
    ),
  ];
}

async function executeDefinition(
  request: HarnessToolRequest,
  context: MasterToolContext,
  config: HarnessConfig,
  definitions: Map<string, ToolDefinition>,
): Promise<string> {
  const definition = definitions.get(request.name);
  if (!definition) return `Tool error: Unknown tool ${request.name}.`;

  let input: Record<string, unknown>;
  try {
    const parsed = request.arguments.trim() ? JSON.parse(request.arguments) : {};
    input = await definition.parse(parsed);
  } catch (error) {
    return `Tool error: ${formatValidationError(error)}`;
  }

  const now = new Date().toISOString();
  const policy = mergePermissions(
    context.agent.permissions[definition.permission],
    configuredPermission(config.permission, definition.name),
  );
  let toolCall: ToolCall = {
    id: crypto.randomUUID(),
    runId: context.runId,
    threadId: context.threadId,
    agentId: context.agent.id,
    name: definition.name,
    permission: definition.permission,
    status: policy === "ask" ? "waiting_approval" : policy === "allow" ? "running" : "denied",
    input: context
      .redact(toolInputSummary(definition.name, input, definition.permission))
      .slice(0, 4_000),
    ...(definition.name === "question" ? { questions: input.questions as ToolQuestion[] } : {}),
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
    if (definition.name === "question") {
      if (!context.hooks?.requestInput)
        throw new Error("User input is unavailable in this runtime.");
      toolCall = { ...toolCall, status: "waiting_input", updatedAt: new Date().toISOString() };
      const answers = await context.hooks.requestInput(toolCall);
      input = { ...input, __answers: answers };
      toolCall = {
        ...toolCall,
        answers,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      await context.hooks.update(toolCall);
    }
    const output = limitOutput(context.redact(await definition.execute(input, context)));
    toolCall = {
      ...toolCall,
      status: "completed",
      summary: outputSummary(definition.name, output, definition.permission),
      updatedAt: new Date().toISOString(),
    };
    await context.hooks?.update(toolCall);
    return output;
  } catch (error) {
    const message = context.redact(errorMessage(error));
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

const optionalPath = z.string().trim().min(1).max(2_000).default(".");

function zodTool<T extends z.ZodType<Record<string, unknown>>>(
  name: string,
  description: string,
  permission: HarnessPermissionKey,
  parameters: Record<string, unknown>,
  schema: T,
  execute: (input: z.output<T>, context: MasterToolContext) => Promise<string>,
): ToolDefinition {
  return {
    type: "function",
    name,
    description,
    permission,
    parameters,
    parse: async (input) => schema.parseAsync(input),
    execute: (input, context) => execute(input as z.output<T>, context),
  };
}

async function listTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
  config: HarnessConfig,
): Promise<string> {
  const requestedPath = input.path as string;
  const maximumDepth = input.depth as number;
  const files = await repositoryFiles(context, config, requestedPath, "**/*");
  const base = requestedPath === "." ? "" : requestedPath.replace(/^\.\//, "").replace(/\/$/, "");
  const entries = new Map<string, "d" | "f">();
  for (const file of files) {
    const withinBase = base && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
    const parts = withinBase.split("/");
    for (let index = 0; index < Math.min(parts.length, maximumDepth); index += 1) {
      const child = [base, ...parts.slice(0, index + 1)].filter(Boolean).join("/");
      entries.set(child, index === parts.length - 1 ? "f" : "d");
    }
  }
  const lines = [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ENTRIES)
    .map(([path, type]) => `${type} ${path}`);
  if (entries.size > MAX_ENTRIES) lines.push("… result limit reached");
  return lines.join("\n") || "Directory is empty.";
}

async function globTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
  config: HarnessConfig,
): Promise<string> {
  const results = await repositoryFiles(
    context,
    config,
    input.path as string,
    validateGlob(input.pattern as string),
  );
  const limited = results.slice(0, MAX_ENTRIES);
  if (results.length > MAX_ENTRIES) limited.push("… result limit reached");
  return limited.join("\n") || "No files matched.";
}

async function repositoryFiles(
  context: MasterToolContext,
  config: HarnessConfig,
  requestedPath: string,
  pattern: string,
): Promise<string[]> {
  const target = await securePath(context, requestedPath, "read");
  if (!(await stat(target)).isDirectory()) throw new Error(`${requestedPath} is not a directory.`);
  const binary = await findExecutable("rg", context.env);
  if (!binary) throw new Error("File discovery requires ripgrep (rg) in PATH.");
  const args = ["--files", "--hidden", "--no-require-git", "--color", "never"];
  addIgnoreGlobs(args, config.ignore);
  args.push("--", relative(context.workspacePath, target) || ".");
  const result = await runCommand(binary, args, {
    cwd: context.workspacePath,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    env: safeProcessEnv(context.env),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "ripgrep failed.");
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => relative(context.workspacePath, resolve(context.workspacePath, line)))
    .filter((file) => !isSensitivePath(context, resolve(context.workspacePath, file)))
    .sort();
  if (pattern === "**/*") return files;
  return files.filter((file) => {
    const fromTarget = relative(target, resolve(context.workspacePath, file));
    return !fromTarget.startsWith("..") && matchesGlob(fromTarget, pattern);
  });
}

async function grepTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
  config: HarnessConfig,
): Promise<string> {
  const target = await securePath(context, input.path as string, "read");
  const binary = await findExecutable("rg", context.env);
  if (!binary) throw new Error("The grep tool requires ripgrep (rg) in PATH.");
  const targetInfo = await stat(target);
  const files = targetInfo.isDirectory()
    ? await repositoryFiles(
        context,
        config,
        input.path as string,
        validateGlob(input.pattern as string),
      )
    : [relative(context.workspacePath, target)];
  if (files.length === 0) return "No matches found.";
  const args = [
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
    "--no-require-git",
    "--max-filesize",
    "1M",
  ];
  args.push("--", input.query as string, ...files.slice(0, MAX_ENTRIES));
  const result = await runCommand(binary, args, {
    cwd: context.workspacePath,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    env: safeProcessEnv(context.env),
  });
  if (result.exitCode === 1) return "No matches found.";
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "ripgrep failed.");
  return result.stdout.trimEnd();
}

function addIgnoreGlobs(args: string[], patterns: string[]): void {
  for (const pattern of patterns) {
    const glob = pattern.startsWith("!") ? pattern.slice(1) : `!${pattern}`;
    args.push("--glob", glob);
  }
  args.push("--glob", "!.git/**", "--glob", "!.nexestra/**");
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

interface PatchOperation {
  type: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  lines: string[];
}

async function applyPatchTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const operations = parsePatch(input.patchText as string);
  const planned = new Map<string, { content: string; mode?: number }>();
  const deletes = new Set<string>();
  const summaries: string[] = [];
  for (const operation of operations) {
    const file = await securePath(context, operation.path, "write", operation.type === "add");
    if (operation.type === "add") {
      if (await pathExists(file)) throw new Error(`${operation.path} already exists.`);
      const content = `${operation.lines.map(stripAddedLine).join("\n")}\n`;
      ensureFileSize(content);
      planned.set(file, { content });
      summaries.push(`Added ${operation.path}`);
      continue;
    }
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error(`${operation.path} is not an editable text file.`);
    const original = planned.get(file)?.content ?? (await readFile(file, "utf8"));
    if (original.includes("\0")) throw new Error(`${operation.path} is a binary file.`);
    if (operation.type === "delete") {
      deletes.add(file);
      planned.delete(file);
      summaries.push(`Deleted ${operation.path}`);
      continue;
    }
    const updated = applyUpdateHunks(original, operation.lines, operation.path);
    ensureFileSize(updated);
    if (operation.moveTo) {
      const destination = await securePath(context, operation.moveTo, "write", true);
      if (await pathExists(destination)) throw new Error(`${operation.moveTo} already exists.`);
      planned.set(destination, { content: updated, mode: info.mode });
      deletes.add(file);
      summaries.push(`Moved ${operation.path} to ${operation.moveTo}`);
    } else {
      planned.set(file, { content: updated, mode: info.mode });
      summaries.push(`Updated ${operation.path}`);
    }
  }
  for (const [file, value] of planned) {
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, value.content, value.mode);
  }
  for (const file of deletes) await unlink(file);
  return summaries.join("\n");
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Patch must start with *** Begin Patch and end with *** End Patch.");
  }
  lines.pop();
  const operations: PatchOperation[] = [];
  let current: PatchOperation | undefined;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header?.[1] && header[2]) {
      current = {
        type: header[1].toLowerCase() as PatchOperation["type"],
        path: header[2],
        lines: [],
      };
      operations.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move?.[1] && current?.type === "update" && current.lines.length === 0) {
      current.moveTo = move[1];
      continue;
    }
    if (!current) {
      if (line.trim()) throw new Error(`Unexpected patch line: ${line}`);
      continue;
    }
    current.lines.push(line);
  }
  if (operations.length === 0 || operations.length > 50)
    throw new Error("Patch must contain 1–50 file operations.");
  for (const operation of operations) {
    if (
      operation.type === "add" &&
      operation.lines.some((line) => !line.startsWith("+") && line !== "")
    ) {
      throw new Error(`Every added line for ${operation.path} must start with +.`);
    }
    if (operation.type === "delete" && operation.lines.some((line) => line.trim())) {
      throw new Error(`Delete operation for ${operation.path} must not contain hunks.`);
    }
  }
  return operations;
}

function stripAddedLine(line: string): string {
  return line.startsWith("+") ? line.slice(1) : line;
}

function applyUpdateHunks(source: string, lines: string[], path: string): string {
  const sourceLines = source.split("\n");
  const hunks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) hunks.push(current);
      current = [];
    } else if (line !== "*** End of File") {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push(current);
  if (hunks.length === 0) throw new Error(`Update for ${path} has no hunks.`);
  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("-"))
      .map((line) => line.slice(1));
    const newLines = hunk
      .filter((line) => line.startsWith(" ") || line.startsWith("+"))
      .map((line) => line.slice(1));
    if (
      hunk.some((line) => !line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-"))
    ) {
      throw new Error(`Invalid update hunk for ${path}.`);
    }
    const index = findLineSequence(sourceLines, oldLines, cursor);
    if (index < 0) throw new Error(`Patch context was not found in ${path}.`);
    sourceLines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }
  return sourceLines.join("\n");
}

function findLineSequence(lines: string[], expected: string[], start: number): number {
  if (expected.length === 0) return start;
  for (let index = start; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return -1;
}

async function questionTool(input: Record<string, unknown>): Promise<string> {
  const questions = input.questions as ToolQuestion[];
  const answers = input.__answers as string[][];
  if (!answers || answers.length !== questions.length)
    throw new Error("The question response is incomplete.");
  if (
    answers.some(
      (answer, index) => answer.length === 0 || (!questions[index]?.multiple && answer.length > 1),
    )
  ) {
    throw new Error("The question response does not match the requested selection mode.");
  }
  return `User answered: ${questions
    .map(
      (question, index) => `"${question.question}"="${answers[index]?.join(", ") || "Unanswered"}"`,
    )
    .join(", ")}.`;
}

async function webFetchTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  let url = await validatePublicUrl(input.url as string, context);
  const fetchImpl = context.fetch ?? globalThis.fetch;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    response = await fetchImpl(url, {
      redirect: "manual",
      headers: {
        accept:
          input.format === "html"
            ? "text/html, text/plain;q=0.8"
            : "text/markdown, text/plain;q=0.9, text/html;q=0.8",
        "user-agent": "Nexestra/0.1",
      },
      signal: AbortSignal.timeout((input.timeout as number) * 1_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Redirect response did not include a Location header.");
    url = await validatePublicUrl(new URL(location, url).toString(), context);
  }
  if (!response || [301, 302, 303, 307, 308].includes(response.status))
    throw new Error("Too many redirects.");
  const content = await readBoundedResponse(response, MAX_FETCH_BYTES);
  if (!response.ok)
    throw new Error(`Web request returned HTTP ${response.status}: ${content.slice(0, 500)}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!isTextContent(contentType))
    throw new Error(`Unsupported web content type: ${contentType || "unknown"}.`);
  if (input.format === "html" || !contentType.includes("html")) return content;
  return input.format === "text" ? htmlToText(content) : htmlToMarkdown(content);
}

async function webSearchTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
  config: HarnessConfig,
): Promise<string> {
  const fetchImpl = context.fetch ?? globalThis.fetch;
  const parallel = config.websearch.provider === "parallel";
  const url = parallel ? "https://search.parallel.ai/mcp" : "https://mcp.exa.ai/mcp";
  const args = parallel
    ? { objective: input.query, search_queries: [input.query], session_id: context.runId }
    : {
        query: input.query,
        type: input.type,
        numResults: input.numResults,
        livecrawl: input.livecrawl,
        contextMaxCharacters: input.contextMaxCharacters,
      };
  const environment = context.env ?? process.env;
  const apiKey = parallel ? environment.PARALLEL_API_KEY : environment.EXA_API_KEY;
  const output = await callRemoteMcpTool({
    url,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    name: parallel ? "web_search" : "web_search_exa",
    arguments: args,
    timeoutMs: 25_000,
    fetch: fetchImpl,
  });
  return output || "No search results found. Try a different query.";
}

async function validatePublicUrl(value: string, context: MasterToolContext): Promise<URL> {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Web URLs must use HTTP or HTTPS and must not contain user info.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Private-network web URLs are blocked.");
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : context.resolveHost
      ? await context.resolveHost(hostname)
      : (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Private-network web URLs are blocked.");
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(":")) {
    if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [first = 0, second = 0] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isTextContent(contentType: string): boolean {
  return (
    !contentType ||
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level, text) => `${"#".repeat(Number(level))} ${text}\n\n`,
      )
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(p|div|li|ul|ol|blockquote|pre)>/gi, "\n")
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Web response is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Web response is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
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
    if (isSensitivePath(context, resolved))
      throw new Error("Nexestra credentials and auth files are protected.");
    return resolved;
  } catch (error) {
    if (!allowMissing || !isNodeError(error, "ENOENT")) throw error;
  }
  let ancestor = dirname(target);
  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      if (!isWithin(workspace, resolvedAncestor))
        throw new Error("Path resolves outside the repository root.");
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

async function writeAtomic(file: string, content: string, mode?: number): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode });
  await rename(temporary, file);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function ensureFileSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES)
    throw new Error("Patched file would exceed 1 MiB.");
}

function toolInputSummary(
  name: string,
  input: Record<string, unknown>,
  permission: HarnessPermissionKey,
): string {
  if (permission === "external") return compactSummary({ argument_keys: Object.keys(input) });
  if (name === "write") {
    return compactSummary({
      path: input.path,
      bytes: Buffer.byteLength(input.content as string),
    });
  }
  if (name === "edit") {
    return compactSummary({
      path: input.path,
      old_bytes: Buffer.byteLength(input.old_text as string),
      new_bytes: Buffer.byteLength(input.new_text as string),
      replace_all: input.replace_all,
    });
  }
  if (name === "apply_patch") {
    const files = (input.patchText as string)
      .split("\n")
      .flatMap((line) => /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)?.[1] ?? []);
    return compactSummary({ files, bytes: Buffer.byteLength(input.patchText as string) });
  }
  if (name === "webfetch") {
    const url = new URL(input.url as string);
    url.search = "";
    url.hash = "";
    return compactSummary({ ...input, url: url.toString() });
  }
  return compactSummary(input);
}

function compactSummary(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 4_000 ? `${serialized.slice(0, 3_980)}… truncated` : serialized;
}

function outputSummary(name: string, output: string, permission: HarnessPermissionKey): string {
  if (permission === "external") return "External tool completed.";
  if (["read", "grep", "glob", "list", "skill", "webfetch", "websearch"].includes(name)) {
    const lines = output ? output.split("\n").length : 0;
    return `Returned ${lines} line${lines === 1 ? "" : "s"}.`;
  }
  if (name === "bash") return output.split("\n").at(-1)?.slice(0, 200) || "Command finished.";
  if (name === "todowrite") {
    try {
      const todos = JSON.parse(output) as { status?: string }[];
      return `${todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length} open todos.`;
    } catch {
      return "Todo list updated.";
    }
  }
  return output.slice(0, 500);
}

function limitOutput(output: string): string {
  if (Buffer.byteLength(output) <= MAX_TOOL_OUTPUT_BYTES) return output;
  return `${Buffer.from(output).subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8")}\n… output truncated`;
}

function formatValidationError(error: unknown): string {
  if (error instanceof SyntaxError) return "Arguments must be valid JSON.";
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid arguments.";
  return errorMessage(error);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tool execution failed.";
}
