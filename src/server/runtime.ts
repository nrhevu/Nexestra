import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Agent,
  AgentReadiness,
  AgentView,
  MasterAgent,
  Message,
  RuntimeStatus,
  Thread,
  WorkerAgent,
} from "../shared/contracts.js";
import {
  createMasterToolSession,
  type HarnessToolRequest,
  type MasterToolContext,
  type MasterToolHooks,
  type MasterToolSession,
} from "./master-harness.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";
import type { AgentArtifact, FileStore } from "./store.js";

export interface AgentInvocation {
  runId?: string;
  thread: Thread;
  trigger: Message;
  transcriptPath: string;
  transcriptSnapshot: string;
  artifacts?: AgentArtifact[];
  toolHooks?: MasterToolHooks;
}

export interface AgentRunner {
  invoke(agent: Agent, invocation: AgentInvocation): Promise<string>;
  runtimeStatus(): Promise<RuntimeStatus>;
}

interface LocalAgentRunnerOptions {
  store: FileStore;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

export class LocalAgentRunner implements AgentRunner {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly env: NodeJS.ProcessEnv;
  private cachedStatus?: { value: RuntimeStatus; expiresAt: number };

  constructor(private readonly options: LocalAgentRunnerOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.env = options.env ?? process.env;
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    if (this.cachedStatus && this.cachedStatus.expiresAt > Date.now()) {
      return structuredClone(this.cachedStatus.value);
    }
    const [codex, opencode] = await Promise.all([
      this.detectBinary("codex"),
      this.detectBinary("opencode"),
    ]);
    let chatgpt = {
      installed: codex.installed,
      connected: false,
      message: codex.installed ? "Not signed in to ChatGPT." : "Codex CLI is not installed.",
    };
    if (codex.path) {
      const status = await runCommand(codex.path, ["login", "status"], {
        cwd: this.options.store.workspacePath,
        timeoutMs: 8_000,
        env: safeProcessEnv(this.env),
      }).catch(() => undefined);
      const output = `${status?.stdout ?? ""}\n${status?.stderr ?? ""}`.trim();
      const connected = status?.exitCode === 0 && /logged in/i.test(output);
      chatgpt = {
        installed: true,
        connected,
        message: connected
          ? output || "Connected to ChatGPT."
          : output || "Not signed in to ChatGPT.",
      };
    }
    const value: RuntimeStatus = {
      chatgpt,
      harnesses: {
        codex: { installed: codex.installed, version: codex.version },
        opencode: { installed: opencode.installed, version: opencode.version },
      },
    };
    this.cachedStatus = { value, expiresAt: Date.now() + 30_000 };
    return structuredClone(value);
  }

  clearStatusCache(): void {
    this.cachedStatus = undefined;
  }

  async invoke(agent: Agent, invocation: AgentInvocation): Promise<string> {
    if (agent.kind === "worker") {
      return agent.harness === "codex"
        ? this.invokeCodex(agent, invocation)
        : this.invokeOpenCode(agent, invocation);
    }
    return agent.provider.type === "chatgpt"
      ? this.invokeCodex(agent, invocation)
      : this.invokeCustom(agent, invocation);
  }

  private async invokeCodex(agent: Agent, invocation: AgentInvocation): Promise<string> {
    const binary = await findExecutable("codex", this.env);
    if (!binary) throw new Error("Codex CLI was not found in PATH.");
    const runDirectory = join(this.options.store.root, "runs", crypto.randomUUID());
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const lastMessageFile = join(runDirectory, "last-message.txt");
    const prompt = localHarnessPrompt(agent, invocation);
    const masterAccessMode = agent.kind === "master" ? agent.accessMode : undefined;
    const args = ["exec", "--json", "-C", this.options.store.workspacePath];
    if (masterAccessMode === "full") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-s", masterAccessMode === "auto" ? "workspace-write" : "read-only");
    }
    args.push("--skip-git-repo-check", "--ephemeral", "-o", lastMessageFile);
    if (masterAccessMode === "auto") args.push("--approve-for-me");
    if (agent.kind === "worker") {
      if (agent.model) args.push("-m", agent.model);
      if (agent.reasoningEffort) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`);
      }
    } else if (agent.provider.type === "chatgpt" && agent.provider.model) {
      args.push("-m", agent.provider.model);
    }
    for (const entry of invocation.artifacts ?? []) {
      if (entry.localPath && entry.artifact.kind === "image") {
        args.push("--image", entry.localPath);
      }
    }
    args.push(prompt);
    const result = await runCommand(binary, args, {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5 * 60_000,
      env: safeProcessEnv(this.env),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        cleanProcessError(result.stderr || result.stdout, "Codex exited with an error."),
      );
    }
    const fileReply = await readFile(lastMessageFile, "utf8").catch(() => "");
    const reply = fileReply.trim() || parseCodexReply(result.stdout);
    if (!reply) throw new Error("Codex did not return a final response.");
    return reply;
  }

  private async invokeOpenCode(agent: WorkerAgent, invocation: AgentInvocation): Promise<string> {
    const binary = await findExecutable("opencode", this.env);
    if (!binary) throw new Error("OpenCode was not found in PATH.");
    const args = [
      "run",
      "--format",
      "json",
      "--pure",
      "--agent",
      "plan",
      "--dir",
      this.options.store.workspacePath,
    ];
    if (agent.model) args.push("-m", agent.model);
    if (agent.reasoningEffort) args.push("--variant", agent.reasoningEffort);
    args.push("--file", invocation.transcriptPath);
    for (const entry of invocation.artifacts ?? []) {
      if (entry.localPath) args.push("--file", entry.localPath);
    }
    args.push("--", localHarnessPrompt(agent, invocation));
    const result = await runCommand(binary, args, {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5 * 60_000,
      env: safeProcessEnv(this.env),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        cleanProcessError(result.stderr || result.stdout, "OpenCode exited with an error."),
      );
    }
    const reply = parseOpenCodeReply(result.stdout);
    if (!reply) throw new Error("OpenCode did not return a final response.");
    return reply;
  }

  private async invokeCustom(agent: MasterAgent, invocation: AgentInvocation): Promise<string> {
    if (agent.provider.type !== "custom") throw new Error("Invalid provider.");
    const url = providerEndpoint(agent.provider.baseUrl, agent.provider.protocol);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const credential = this.options.store.getCredential(agent.id);
    if (credential) headers.authorization = `Bearer ${credential}`;
    const context: MasterToolContext = {
      agent,
      runId: invocation.runId ?? crypto.randomUUID(),
      threadId: invocation.thread.id,
      workspacePath: this.options.store.workspacePath,
      dataPath: this.options.store.root,
      readableArtifactPaths: (invocation.artifacts ?? []).flatMap((entry) =>
        entry.localPath ? [entry.localPath] : [],
      ),
      hooks: invocation.toolHooks,
      env: this.env,
      fetch: this.fetchImpl,
      redact: (value: string) => this.options.store.redactSecrets(value),
    };
    const tools = await createMasterToolSession(context);
    const system = [
      `You are ${agent.name} (@${agent.handle}), Nexestra's internal Master agent.`,
      "You are responding in a shared thread with the user and other agents.",
      "Answer the exact message that just @mentioned you. Use tools when repository evidence or a code change is needed.",
      "Keep working through tool results until the request is resolved, then return a concise final answer in the user's language.",
      tools.warnings.length > 0
        ? `Some configured extensions could not start:\n${tools.warnings.map((warning) => `- ${warning}`).join("\n")}`
        : "",
      agent.instructions,
    ]
      .filter(Boolean)
      .join("\n\n");
    let reply: string;
    try {
      reply =
        agent.provider.protocol === "openai-chat"
          ? await this.runChatToolLoop(agent, url, headers, system, invocation, tools)
          : await this.runResponsesToolLoop(agent, url, headers, system, invocation, tools);
    } finally {
      await tools.close();
    }
    if (!reply)
      throw new Error(`Provider ${agent.provider.name} did not include response content.`);
    if (reply.length > 40_000) {
      throw new Error(`Provider ${agent.provider.name} returned a response that is too long.`);
    }
    return this.options.store.redactSecrets(reply);
  }

  private async runChatToolLoop(
    agent: MasterAgent,
    url: string,
    headers: Record<string, string>,
    system: string,
    invocation: AgentInvocation,
    tools: MasterToolSession,
  ): Promise<string> {
    const messages: Record<string, unknown>[] = [
      { role: "system", content: system },
      { role: "user", content: await providerChatUserContent(invocation) },
    ];
    const repeatedCalls = new Map<string, number>();
    for (let turn = 0; turn <= 12; turn += 1) {
      const toolsEnabled = turn < 12;
      const payload = await this.providerRequest(agent, url, headers, {
        model: customProviderModel(agent),
        messages,
        ...(toolsEnabled
          ? {
              tools: tools.definitions.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : { tool_choice: "none" }),
      });
      const calls = parseChatToolCalls(payload);
      if (calls.length === 0) return parseProviderReply(payload);
      if (!toolsEnabled) throw new Error("Provider continued calling tools after the step limit.");
      guardRepeatedCalls(calls, repeatedCalls);
      messages.push({
        role: "assistant",
        content: chatAssistantContent(payload),
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of calls) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await tools.execute(call),
        });
      }
    }
    throw new Error("Provider exceeded the tool step limit.");
  }

  private async runResponsesToolLoop(
    agent: MasterAgent,
    url: string,
    headers: Record<string, string>,
    system: string,
    invocation: AgentInvocation,
    tools: MasterToolSession,
  ): Promise<string> {
    const input: unknown[] = [
      { role: "user", content: await providerResponsesUserContent(invocation) },
    ];
    const repeatedCalls = new Map<string, number>();
    for (let turn = 0; turn <= 12; turn += 1) {
      const toolsEnabled = turn < 12;
      const payload = await this.providerRequest(agent, url, headers, {
        model: customProviderModel(agent),
        instructions: system,
        input,
        ...(toolsEnabled ? { tools: tools.definitions } : { tool_choice: "none" }),
      });
      const calls = parseResponsesToolCalls(payload);
      if (calls.length === 0) return parseProviderReply(payload);
      if (!toolsEnabled) throw new Error("Provider continued calling tools after the step limit.");
      guardRepeatedCalls(calls, repeatedCalls);
      if (isRecord(payload) && Array.isArray(payload.output)) input.push(...payload.output);
      for (const call of calls) {
        input.push({
          type: "function_call_output",
          call_id: call.id,
          output: await tools.execute(call),
        });
      }
    }
    throw new Error("Provider exceeded the tool step limit.");
  }

  private async providerRequest(
    agent: MasterAgent,
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3 * 60_000),
    });
    const text = await readBoundedResponse(response, 1024 * 1024);
    if (!response.ok) {
      throw new Error(
        this.options.store.redactSecrets(
          `Provider ${customProviderName(agent)} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
        ),
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Provider ${customProviderName(agent)} did not return valid JSON.`);
    }
  }

  private async detectBinary(name: "codex" | "opencode") {
    const path = await findExecutable(name, this.env);
    if (!path) return { installed: false, version: null, path: undefined };
    const result = await runCommand(path, ["--version"], {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5_000,
      env: safeProcessEnv(this.env),
    }).catch(() => undefined);
    const version = result?.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : null;
    return { installed: true, version: version || null, path };
  }
}

export function agentView(
  agent: Agent,
  runtime: RuntimeStatus,
  busyAgentIds: ReadonlySet<string>,
): AgentView {
  let readiness: AgentReadiness = "ready";
  let readinessLabel = "Ready";
  if (!agent.enabled || agent.archived) {
    readiness = "disabled";
    readinessLabel = agent.archived ? "Archived" : "Disabled";
  } else if (busyAgentIds.has(agent.id)) {
    readiness = "busy";
    readinessLabel = "Responding";
  } else if (agent.kind === "worker" && !runtime.harnesses[agent.harness].installed) {
    readiness = "unavailable";
    readinessLabel = `${agent.harness === "codex" ? "Codex" : "OpenCode"} is not installed`;
  } else if (agent.kind === "master" && agent.provider.type === "chatgpt") {
    if (!runtime.chatgpt.installed || !runtime.chatgpt.connected) {
      readiness = "needs_setup";
      readinessLabel = runtime.chatgpt.installed
        ? "Sign-in required"
        : "Codex CLI is not installed";
    }
  }
  return { ...agent, readiness, readinessLabel };
}

function localHarnessPrompt(agent: Agent, invocation: AgentInvocation): string {
  const role = agent.kind === "master" ? "Master agent" : `${agent.harness} worker`;
  const artifactContext = formatInvocationArtifacts(invocation);
  return [
    `You are ${agent.name} (@${agent.handle}), a ${role} in Nexestra.`,
    `The user just mentioned you in thread #${invocation.thread.slug}.`,
    `Required message to answer (id: ${invocation.trigger.id}):\n${invocation.trigger.content}`,
    "Answer the message above even if the transcript contains newer messages.",
    `Shared transcript path: ${invocation.transcriptPath}`,
    "Read the transcript for relevant context.",
    artifactContext,
    agent.kind === "worker"
      ? "This is a discussion turn: do not modify files or run commands that change state."
      : masterCodexAccessPrompt(agent),
    "Return only the response content so Nexestra can write it to the thread.",
    agent.instructions ? `Agent-specific instructions:\n${agent.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatInvocationArtifacts(invocation: AgentInvocation): string {
  if (!invocation.artifacts?.length) return "";
  return [
    "Artifacts attached or referenced by the required message:",
    ...invocation.artifacts.map(({ artifact, localPath }) => {
      const target = localPath ?? artifact.url ?? artifact.path ?? "metadata only";
      return `- [${artifact.kind}] ${artifact.name}: ${target}`;
    }),
  ].join("\n");
}

function masterCodexAccessPrompt(agent: MasterAgent): string {
  if (agent.accessMode === "full") {
    return "Full access is enabled. Complete the requested work directly, while protecting credentials and avoiding unrelated or destructive changes.";
  }
  if (agent.accessMode === "auto") {
    return "You may inspect the repository, edit files, and run commands inside the Codex workspace-write sandbox. Complete the requested work before replying.";
  }
  return "Inspect the repository as needed, but do not modify files or run commands that change state.";
}

function providerUserPrompt(invocation: AgentInvocation): string {
  return [
    `Required message to answer (id: ${invocation.trigger.id}):`,
    invocation.trigger.content,
    "Answer the message above even if the transcript contains newer messages.",
    formatInvocationArtifacts(invocation),
    `Shared transcript for #${invocation.thread.slug}:`,
    invocation.transcriptSnapshot,
  ].join("\n\n");
}

async function providerChatUserContent(
  invocation: AgentInvocation,
): Promise<string | Record<string, unknown>[]> {
  const attachments = await providerAttachments(invocation);
  const text = [providerUserPrompt(invocation), attachments.text].filter(Boolean).join("\n\n");
  if (attachments.images.length === 0) return text;
  return [
    { type: "text", text },
    ...attachments.images.map((image) => ({
      type: "image_url",
      image_url: { url: image.dataUrl },
    })),
  ];
}

async function providerResponsesUserContent(
  invocation: AgentInvocation,
): Promise<Record<string, unknown>[]> {
  const attachments = await providerAttachments(invocation);
  return [
    {
      type: "input_text",
      text: [providerUserPrompt(invocation), attachments.text].filter(Boolean).join("\n\n"),
    },
    ...attachments.images.map((image) => ({
      type: "input_image",
      image_url: image.dataUrl,
    })),
  ];
}

async function providerAttachments(invocation: AgentInvocation): Promise<{
  text: string;
  images: { dataUrl: string }[];
}> {
  const textParts: string[] = [];
  const images: { dataUrl: string }[] = [];
  let textBytes = 0;
  let imageBytes = 0;
  for (const { artifact, localPath } of invocation.artifacts ?? []) {
    if (!localPath) continue;
    if (artifact.kind === "image") {
      if (imageBytes + (artifact.size ?? 0) > 10 * 1024 * 1024) {
        textParts.push(`[Image omitted from provider payload because of size: ${artifact.name}]`);
        continue;
      }
      const bytes = await readFile(localPath);
      if (imageBytes + bytes.byteLength > 10 * 1024 * 1024) {
        textParts.push(`[Image omitted from provider payload because of size: ${artifact.name}]`);
        continue;
      }
      imageBytes += bytes.byteLength;
      images.push({
        dataUrl: `data:${artifact.mediaType ?? "application/octet-stream"};base64,${bytes.toString("base64")}`,
      });
      continue;
    }
    if (!isTextArtifact(artifact.mediaType) || textBytes >= 512 * 1024) continue;
    const bytes = await readFile(localPath);
    const remaining = 512 * 1024 - textBytes;
    const included = bytes.subarray(0, Math.min(bytes.byteLength, remaining));
    textBytes += included.byteLength;
    textParts.push(
      [`Attached text file: ${artifact.name}`, "```", included.toString("utf8"), "```"].join("\n"),
    );
  }
  return { text: textParts.join("\n\n"), images };
}

function isTextArtifact(mediaType?: string): boolean {
  return Boolean(
    mediaType?.startsWith("text/") ||
      mediaType === "application/json" ||
      mediaType === "application/yaml",
  );
}

function providerEndpoint(baseUrl: string, protocol: "openai-chat" | "openai-responses"): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Custom providers only support HTTP or HTTPS URLs.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Base URL must not include user info, a query string, or a fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Remote custom providers must use HTTPS.");
  }
  const suffix = protocol === "openai-chat" ? "chat/completions" : "responses";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${suffix}`;
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.startsWith("127.")
  );
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Custom provider returned too much data.");
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
        throw new Error("Custom provider returned too much data.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function parseCodexReply(output: string): string {
  let reply = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        reply = event.item.text?.trim() ?? reply;
      }
    } catch {
      // Codex may print warnings around its JSONL stream; ignore them.
    }
  }
  return reply;
}

export function parseOpenCodeReply(output: string): string {
  let reply = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (event.type === "text" && event.part?.type === "text" && event.part.text?.trim()) {
        reply = event.part.text.trim();
      }
    } catch {
      // OpenCode's JSON format is line oriented; ignore malformed diagnostics.
    }
  }
  return reply;
}

export function parseProviderReply(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const choices = payload.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first) && isRecord(first.message)) {
      if (typeof first.message.content === "string") return first.message.content.trim();
      if (Array.isArray(first.message.content)) {
        return first.message.content
          .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
          .join("\n")
          .trim();
      }
    }
  }
  if (Array.isArray(payload.output)) {
    const parts: string[] = [];
    for (const item of payload.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === "string") parts.push(content.text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

function parseChatToolCalls(payload: unknown): HarnessToolRequest[] {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return [];
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || !Array.isArray(first.message.tool_calls)) {
    return [];
  }
  return first.message.tool_calls.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.function)) return [];
    if (typeof value.function.name !== "string") return [];
    return [
      {
        id: value.id,
        name: value.function.name,
        arguments:
          typeof value.function.arguments === "string"
            ? value.function.arguments
            : JSON.stringify(value.function.arguments ?? {}),
      },
    ];
  });
}

function parseResponsesToolCalls(payload: unknown): HarnessToolRequest[] {
  if (!isRecord(payload) || !Array.isArray(payload.output)) return [];
  return payload.output.flatMap((value) => {
    if (
      !isRecord(value) ||
      value.type !== "function_call" ||
      typeof value.call_id !== "string" ||
      typeof value.name !== "string"
    ) {
      return [];
    }
    return [
      {
        id: value.call_id,
        name: value.name,
        arguments:
          typeof value.arguments === "string"
            ? value.arguments
            : JSON.stringify(value.arguments ?? {}),
      },
    ];
  });
}

function chatAssistantContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  return typeof first.message.content === "string" ? first.message.content : null;
}

function guardRepeatedCalls(calls: HarnessToolRequest[], repeatedCalls: Map<string, number>): void {
  for (const call of calls) {
    const signature = `${call.name}\n${canonicalArguments(call.arguments)}`;
    const count = (repeatedCalls.get(signature) ?? 0) + 1;
    repeatedCalls.set(signature, count);
    if (count >= 3) throw new Error(`Stopped a repeated ${call.name} tool-call loop.`);
  }
}

function canonicalArguments(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value.trim();
  }
}

function customProviderModel(agent: MasterAgent): string {
  if (agent.provider.type !== "custom") throw new Error("Invalid custom provider.");
  return agent.provider.model;
}

function customProviderName(agent: MasterAgent): string {
  if (agent.provider.type !== "custom") throw new Error("Invalid custom provider.");
  return agent.provider.name;
}

function cleanProcessError(output: string, fallback: string): string {
  const cleaned = output.trim();
  return cleaned ? cleaned.slice(-2_000) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
