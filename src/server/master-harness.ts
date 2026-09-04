import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  HarnessPermissionKey,
  MasterAccessMode,
  ToolCall,
  ToolPermission,
  ToolQuestion,
} from "../shared/contracts.js";
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
const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_READ_LINE_LENGTH = 2_000;
const DEFAULT_READ_LIMIT = 2_000;
const MAX_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;

export interface MasterToolSession {
  definitions: ProviderToolDefinition[];
  warnings: string[];
  pendingTaskIds(): string[];
  execute(request: HarnessToolRequest): Promise<string>;
  close(): Promise<void>;
}

interface PlanState {
  plannedTaskIds: Set<string>;
  delegatingTaskIds: Set<string>;
}

export async function createMasterToolSession(
  context: MasterToolContext,
): Promise<MasterToolSession> {
  const config = await loadHarnessConfig(context.workspacePath);
  const skills = await discoverSkills(context);
  const extensionsEnabled = configuredPermission(config.permission, "__extension__") !== "deny";
  const custom = extensionsEnabled
    ? await loadCustomTools(config, context)
    : { tools: [], warnings: [] };
  const mcp = extensionsEnabled
    ? await loadMcpTools(config, context)
    : { tools: [], warnings: [], close: async () => undefined };
  const planState: PlanState = {
    plannedTaskIds: new Set(),
    delegatingTaskIds: new Set(),
  };
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of builtInTools(config, skills, planState)) definitions.set(tool.name, tool);
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
    pendingTaskIds: () => [...planState.plannedTaskIds],
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

function builtInTools(
  config: HarnessConfig,
  skills: HarnessSkill[],
  planState: PlanState,
): ToolDefinition[] {
  let todos: Record<string, unknown>[] = [];
  const { plannedTaskIds, delegatingTaskIds } = planState;
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
          pattern: stringProperty("The regular expression to search for."),
          path: stringProperty("File or directory relative to the repository root."),
          include: stringProperty("Optional glob limiting files, for example **/*.ts."),
        },
        ["pattern"],
      ),
      z
        .object({
          query: z.string().min(1).max(500).optional(),
          include: z.string().trim().min(1).max(500).optional(),
          pattern: z.string().trim().min(1).max(500).optional(),
          path: optionalPath,
        })
        .refine((input) => Boolean(input.query || input.pattern), "pattern is required")
        .transform((input) => ({
          query: input.query ?? input.pattern ?? "",
          path: input.path,
          pattern: input.include ?? (input.query ? input.pattern : undefined) ?? "**/*",
        })),
      (input, context) => grepTool(input, context, config),
    ),
    zodTool(
      "read",
      "Read a UTF-8 repository file or an attached artifact with line numbers.",
      "read",
      objectSchema(
        {
          filePath: stringProperty(
            "Absolute or repository-relative path, including an attached artifact path supplied in the message.",
          ),
          offset: integerProperty(1, 1_000_000_000),
          limit: integerProperty(1, 10_000),
        },
        ["filePath"],
      ),
      z
        .object({
          filePath: z.string().trim().min(1).max(2_000).optional(),
          path: z.string().trim().min(1).max(2_000).optional(),
          offset: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(10_000).default(DEFAULT_READ_LIMIT),
        })
        .refine((input) => Boolean(input.filePath || input.path), "filePath is required")
        .transform((input) => ({ ...input, path: input.filePath ?? input.path ?? "" })),
      readTool,
    ),
    zodTool(
      "edit",
      "Replace exact text in an existing repository file.",
      "edit",
      objectSchema(
        {
          filePath: stringProperty("Absolute or repository-relative file path."),
          oldString: stringProperty("Exact text to replace."),
          newString: stringProperty("Replacement text, which must differ from oldString."),
          replaceAll: { type: "boolean", description: "Replace every match instead of one." },
        },
        ["filePath", "oldString", "newString"],
      ),
      z
        .object({
          filePath: z.string().trim().min(1).max(2_000).optional(),
          path: z.string().trim().min(1).max(2_000).optional(),
          oldString: z.string().max(MAX_FILE_BYTES).optional(),
          old_text: z.string().max(MAX_FILE_BYTES).optional(),
          newString: z.string().max(MAX_FILE_BYTES).optional(),
          new_text: z.string().max(MAX_FILE_BYTES).optional(),
          replaceAll: z.boolean().optional(),
          replace_all: z.boolean().optional(),
        })
        .refine((input) => Boolean(input.filePath || input.path), "filePath is required")
        .refine(
          (input) => input.oldString !== undefined || input.old_text !== undefined,
          "oldString is required",
        )
        .refine(
          (input) => input.newString !== undefined || input.new_text !== undefined,
          "newString is required",
        )
        .transform((input) => ({
          path: input.filePath ?? input.path ?? "",
          old_text: input.oldString ?? input.old_text ?? "",
          new_text: input.newString ?? input.new_text ?? "",
          replace_all: input.replaceAll ?? input.replace_all ?? false,
        })),
      editTool,
    ),
    zodTool(
      "write",
      "Create or replace a UTF-8 file inside the repository.",
      "edit",
      objectSchema(
        {
          filePath: stringProperty("Absolute or repository-relative file path."),
          content: stringProperty("Complete file contents."),
        },
        ["filePath", "content"],
      ),
      z
        .object({
          filePath: z.string().trim().min(1).max(2_000).optional(),
          path: z.string().trim().min(1).max(2_000).optional(),
          content: z.string().max(MAX_FILE_BYTES),
        })
        .refine((input) => Boolean(input.filePath || input.path), "filePath is required")
        .transform((input) => ({
          path: input.filePath ?? input.path ?? "",
          content: input.content,
        })),
      writeTool,
    ),
    zodTool(
      "bash",
      "Run a shell command in the repository with bounded time and output.",
      "bash",
      objectSchema(
        {
          command: stringProperty("Shell command to run from the repository root."),
          timeout: integerProperty(1_000, 600_000),
          workdir: stringProperty("Repository directory to run the command in."),
        },
        ["command"],
      ),
      z
        .object({
          command: z.string().trim().min(1).max(20_000),
          timeout: z.number().int().min(1_000).max(600_000).optional(),
          timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
          workdir: z.string().trim().min(1).max(2_000).default("."),
        })
        .transform((input) => ({
          command: input.command,
          timeout_ms: input.timeout ?? input.timeout_ms ?? 120_000,
          workdir: input.workdir,
        })),
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
      async (input, context) => {
        const skill = skills.find((entry) => entry.name === input.name);
        if (!skill) throw new Error(`Skill ${String(input.name)} was not found.`);
        return readSkill(skill, context);
      },
    ),
    zodTool(
      "plan",
      "Create the required execution plan as durable Taskboard tasks before delegating work.",
      "todowrite",
      objectSchema(
        {
          title: stringProperty("Short name for the overall plan."),
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                title: stringProperty("Concrete task title."),
                description: stringProperty("Acceptance criteria and implementation scope."),
              },
              required: ["title", "description"],
              additionalProperties: false,
            },
          },
        },
        ["title", "steps"],
      ),
      z.object({
        title: z.string().trim().min(1).max(160),
        steps: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(160),
              description: z.string().trim().min(1).max(1_800),
            }),
          )
          .min(1)
          .max(20),
      }),
      async (input, context) => {
        if (!context.hooks?.createPlan) {
          throw new Error("Planning is unavailable in this runtime.");
        }
        const tasks = await context.hooks.createPlan(input.title, input.steps);
        for (const task of tasks) plannedTaskIds.add(task.id);
        return JSON.stringify(
          {
            title: input.title,
            tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
          },
          null,
          2,
        );
      },
    ),
    zodTool(
      "delegate",
      "Assign one planned task to a Worker in an isolated worktree of a ready #repository. Use any Worker handle and repository handle listed in the conversation context.",
      "edit",
      objectSchema(
        {
          taskId: stringProperty("Task ID returned by the plan tool."),
          worker: stringProperty("Worker handle without @."),
          repository: stringProperty("Knowledge repository handle without #."),
        },
        ["taskId", "worker", "repository"],
      ),
      z.object({
        taskId: z.string().uuid(),
        worker: z.string().trim().min(2).max(31),
        repository: z.string().trim().min(2).max(48),
      }),
      async (input, context) => {
        if (!plannedTaskIds.has(input.taskId)) {
          throw new Error("Call plan first, then delegate only task IDs returned by that plan.");
        }
        if (delegatingTaskIds.has(input.taskId)) {
          throw new Error("This planned task is already being delegated.");
        }
        if (!context.hooks?.delegate) {
          throw new Error("Worker delegation is unavailable in this runtime.");
        }
        delegatingTaskIds.add(input.taskId);
        try {
          const { assignment, result } = await context.hooks.delegate({
            taskId: input.taskId,
            workerHandle: input.worker.toLowerCase(),
            repositoryHandle: input.repository.toLowerCase(),
          });
          plannedTaskIds.delete(input.taskId);
          return JSON.stringify(
            {
              assignmentId: assignment.id,
              status: assignment.status,
              branch: assignment.branch,
              worktreePath: assignment.worktreePath,
              workerResult: result,
            },
            null,
            2,
          );
        } finally {
          delegatingTaskIds.delete(input.taskId);
        }
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
    accessModePermission(context.agent.accessMode, definition.permission),
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
    const output = await limitOutput(
      context.redact(await definition.execute(input, context)),
      context,
      definition.name === "bash" ? "tail" : "head",
    );
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

function accessModePermission(
  mode: MasterAccessMode,
  permission: HarnessPermissionKey,
): ToolPermission {
  if (mode === "full") return "allow";
  if (mode === "auto") return permission === "external" ? "ask" : "allow";
  return ["read", "skill", "todowrite", "question"].includes(permission) ? "allow" : "ask";
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
  const limited = results
    .slice(0, MAX_SEARCH_RESULTS)
    .map((file) => resolve(context.workspacePath, file));
  if (results.length >= MAX_SEARCH_RESULTS) {
    limited.push(
      "",
      `(Results are truncated: showing first ${MAX_SEARCH_RESULTS} results. Consider using a more specific path or pattern.)`,
    );
  }
  return limited.join("\n") || "No files found";
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
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
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
  addIgnoreGlobs(args, config.ignore);
  const include = validateGlob(input.pattern as string);
  if (include !== "**/*") args.push("--glob", include);
  args.push("--", input.query as string, relative(context.workspacePath, target) || ".");
  const result = await runCommand(binary, args, {
    cwd: context.workspacePath,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    env: safeProcessEnv(context.env),
  });
  if (result.exitCode === 1) return "No files found";
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "ripgrep failed.");
  const rows = result.stdout
    .trimEnd()
    .split("\n")
    .flatMap((line) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!match?.[1] || !match[2]) return [];
      return [
        { path: resolve(context.workspacePath, match[1]), line: match[2], text: match[3] ?? "" },
      ];
    });
  const selected = rows.slice(0, MAX_SEARCH_RESULTS);
  if (selected.length === 0) return "No files found";
  const output = [
    `Found ${selected.length} matches${rows.length >= MAX_SEARCH_RESULTS ? " (more matches available)" : ""}`,
  ];
  let currentPath = "";
  for (const row of selected) {
    if (row.path !== currentPath) {
      if (currentPath) output.push("");
      currentPath = row.path;
      output.push(`${row.path}:`);
    }
    output.push(`  Line ${row.line}: ${row.text}`);
  }
  if (rows.length >= MAX_SEARCH_RESULTS) {
    output.push("", "(Results truncated. Consider using a more specific path or pattern.)");
  }
  return output.join("\n");
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
  const file = await secureReadPath(context, requestedPath);
  const info = await stat(file);
  const offset = input.offset as number;
  const limit = input.limit as number;
  if (info.isDirectory()) {
    const entries = (await readdir(file, { withFileTypes: true }))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.localeCompare(right));
    const selected = entries.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + selected.length < entries.length;
    return [
      `<path>${file}</path>`,
      "<type>directory</type>",
      "<entries>",
      selected.join("\n"),
      truncated
        ? `(Showing ${selected.length} of ${entries.length} entries. Use offset=${offset + selected.length} to continue.)`
        : `(${entries.length} entries)`,
      "</entries>",
    ].join("\n");
  }
  if (!info.isFile()) throw new Error(`${requestedPath} is not a file.`);
  const sample = await readSample(file, Math.min(info.size, 4_096));
  if (isBinaryFile(file, sample)) throw new Error(`Cannot read binary file: ${requestedPath}`);
  const slice = await readTextSlice(file, offset, limit);
  if (slice.totalLines < offset && !(slice.totalLines === 0 && offset === 1)) {
    throw new Error(`Offset ${offset} is out of range for this file (${slice.totalLines} lines).`);
  }
  const last = offset + slice.lines.length - 1;
  const next = last + 1;
  const notice = slice.byteLimited
    ? `(Output capped at 50 KB. Showing lines ${offset}-${last}. Use offset=${next} to continue.)`
    : slice.hasMore
      ? `(Showing lines ${offset}-${last} of ${slice.totalLines}. Use offset=${next} to continue.)`
      : `(End of file - total ${slice.totalLines} lines)`;
  return [
    `<path>${file}</path>`,
    "<type>file</type>",
    "<content>",
    ...slice.lines.map((line, index) => `${offset + index}: ${line}`),
    "",
    notice,
    "</content>",
  ].join("\n");
}

async function readSample(file: string, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isBinaryFile(file: string, sample: Uint8Array): boolean {
  if (
    [
      ".zip",
      ".tar",
      ".gz",
      ".exe",
      ".dll",
      ".so",
      ".class",
      ".jar",
      ".war",
      ".7z",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".bin",
      ".wasm",
    ].includes(extname(file).toLowerCase())
  ) {
    return true;
  }
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1;
  }
  return nonPrintable / sample.length > 0.3;
}

async function readTextSlice(
  file: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number; hasMore: boolean; byteLimited: boolean }> {
  const input = createReadStream(file);
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const lines: string[] = [];
  let totalLines = 0;
  let bytes = 0;
  let hasMore = false;
  let byteLimited = false;
  try {
    for await (const rawLine of reader) {
      totalLines += 1;
      if (totalLines < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        continue;
      }
      const line =
        rawLine.length > MAX_READ_LINE_LENGTH
          ? `${rawLine.slice(0, MAX_READ_LINE_LENGTH)}... (line truncated to ${MAX_READ_LINE_LENGTH} chars)`
          : rawLine;
      const size = Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
      if (bytes + size > MAX_TOOL_OUTPUT_BYTES) {
        byteLimited = true;
        hasMore = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return { lines, totalLines, hasMore, byteLimited };
}

async function secureReadPath(context: MasterToolContext, requestedPath: string): Promise<string> {
  if (!isAbsolute(requestedPath)) return securePath(context, requestedPath, "read");
  const requested = resolve(requestedPath);
  const allowed = context.readableArtifactPaths?.some(
    (artifactPath) => isAbsolute(artifactPath) && resolve(artifactPath) === requested,
  );
  if (allowed) {
    const directInfo = await lstat(requested);
    if (!directInfo.isFile()) throw new Error("Attached artifact paths must be regular files.");
    const resolved = await realpath(requested);
    if (isCredentialPath(context, resolved)) {
      throw new Error("Nexestra credentials and auth files are protected.");
    }
    return resolved;
  }
  const workspace = await realpath(context.workspacePath);
  if (isWithin(workspace, requested)) return securePath(context, requested, "read");
  throw new Error("Paths must stay inside the repository root or reference an attached artifact.");
}

async function editTool(
  input: Record<string, unknown>,
  context: MasterToolContext,
): Promise<string> {
  const requestedPath = input.path as string;
  const oldTextInput = input.old_text as string;
  const newTextInput = input.new_text as string;
  if (oldTextInput === newTextInput) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }
  const file = await securePath(context, requestedPath, "write", oldTextInput === "");
  if (oldTextInput === "") {
    if (await pathExists(file)) {
      throw new Error(
        "oldString cannot be empty when editing an existing file. Use write for an intentional full-file replacement.",
      );
    }
    if (Buffer.byteLength(newTextInput) > MAX_FILE_BYTES) {
      throw new Error("Edited file would exceed 1 MiB.");
    }
    await mkdir(dirname(file), { recursive: true });
    await writeAtomic(file, newTextInput);
    return `Created ${requestedPath}.`;
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${requestedPath} is not a file.`);
  if (info.size > MAX_FILE_BYTES) throw new Error("File is larger than 1 MiB.");
  const content = await readFile(file, "utf8");
  if (content.includes("\0")) throw new Error("Binary files cannot be edited.");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const oldText = normalizeLineEndings(oldTextInput).replaceAll("\n", lineEnding);
  const newText = normalizeLineEndings(newTextInput).replaceAll("\n", lineEnding);
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) throw new Error("old_text was not found.");
  if (!input.replace_all && occurrences !== 1) {
    throw new Error(
      `old_text matched ${occurrences} times; provide more context or use replace_all.`,
    );
  }
  const updated = input.replace_all
    ? content.replaceAll(oldText, newText)
    : content.replace(oldText, newText);
  if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
    throw new Error("Edited file would exceed 1 MiB.");
  await writeAtomic(file, updated, info.mode);
  return `Updated ${requestedPath} (${input.replace_all ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"}).`;
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
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
  const workdir = await securePath(context, input.workdir as string, "read");
  if (!(await stat(workdir)).isDirectory()) throw new Error("Shell workdir must be a directory.");
  const env = safeProcessEnv(context.env);
  delete env.CODEX_HOME;
  delete env.OPENCODE_CONFIG;
  const result = await runCommand("/bin/bash", ["-lc", input.command as string], {
    cwd: workdir,
    timeoutMs: input.timeout_ms as number,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
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
  const workspace = await realpath(context.workspacePath);
  const target = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspace, requestedPath);
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
  const dataRoot = resolve(context.dataPath);
  const workspace = resolve(context.workspacePath);
  const resolvedTarget = resolve(target);
  if (isCredentialPath(context, resolvedTarget)) return true;
  if (resolve(resolvedTarget) === resolve(dataRoot, "state.json")) return true;
  const nestedDataRoot = dataRoot !== workspace && isWithin(workspace, dataRoot);
  if (!nestedDataRoot || !isWithin(dataRoot, resolvedTarget)) return false;
  if (isWithin(join(dataRoot, "workspaces"), resolvedTarget)) return false;
  if (isWithin(join(dataRoot, "threads"), resolvedTarget)) return true;
  if (isWithin(join(dataRoot, "runs"), resolvedTarget)) return true;
  if (isWithin(join(dataRoot, "artifacts"), resolvedTarget)) return true;
  return true;
}

function isCredentialPath(context: MasterToolContext, target: string): boolean {
  if (resolve(target) === resolve(context.dataPath, "credentials.json")) return true;
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

async function limitOutput(
  output: string,
  context: MasterToolContext,
  direction: "head" | "tail",
): Promise<string> {
  const lines = output.split("\n");
  if (lines.length <= DEFAULT_READ_LIMIT && Buffer.byteLength(output) <= MAX_TOOL_OUTPUT_BYTES) {
    return output;
  }
  const directory = resolve(context.dataPath, "runs", "tool-output");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, crypto.randomUUID());
  await writeFile(file, output, { mode: 0o600 });
  context.readableArtifactPaths ??= [];
  context.readableArtifactPaths.push(file);

  const selected: string[] = [];
  let bytes = 0;
  const start = direction === "head" ? 0 : lines.length - 1;
  const end = direction === "head" ? lines.length : -1;
  const step = direction === "head" ? 1 : -1;
  for (let index = start; index !== end; index += step) {
    if (selected.length >= DEFAULT_READ_LIMIT) break;
    const line = lines[index] ?? "";
    const size = Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0);
    if (bytes + size > MAX_TOOL_OUTPUT_BYTES) break;
    if (direction === "head") selected.push(line);
    else selected.unshift(line);
    bytes += size;
  }
  const preview = selected.join("\n");
  const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse read with offset/limit to view specific sections.`;
  return direction === "head"
    ? `${preview}\n\n... output truncated ...\n\n${hint}`
    : `... output truncated ...\n\n${hint}\n\n${preview}`;
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
