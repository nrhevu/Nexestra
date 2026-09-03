import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Agent,
  AgentReadiness,
  AgentView,
  HarnessPermissionKey,
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

export interface RuntimeToolUpdate {
  id: string;
  name: string;
  permission: HarnessPermissionKey;
  status: "running" | "completed" | "failed";
  input: string;
  summary?: string;
  error?: string;
}

export interface AgentActivityHooks {
  status(stage: "thinking" | "tool" | "responding", detail: string): void;
  text(value: string, mode: "append" | "replace"): void;
  tool(update: RuntimeToolUpdate): Promise<void>;
}

export interface AgentInvocation {
  runId?: string;
  thread: Thread;
  trigger: Message;
  transcriptPath: string;
  transcriptSnapshot: string;
  artifacts?: AgentArtifact[];
  toolHooks?: MasterToolHooks;
  activityHooks?: AgentActivityHooks;
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
    invocation.activityHooks?.status("thinking", "Starting Codex");
    const toolUpdates = queuedToolUpdates(invocation.activityHooks);
    const consume = jsonLineConsumer((event) => {
      handleCodexActivity(event, invocation.activityHooks, toolUpdates.emit);
    });
    const result = await runCommand(binary, args, {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5 * 60_000,
      env: safeProcessEnv(this.env),
      onStdout: consume.push,
    });
    consume.end();
    await toolUpdates.drain();
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
    args.push("--thinking");
    args.push("--file", invocation.transcriptPath);
    for (const entry of invocation.artifacts ?? []) {
      if (entry.localPath) args.push("--file", entry.localPath);
    }
    args.push("--", localHarnessPrompt(agent, invocation));
    invocation.activityHooks?.status("thinking", "Starting OpenCode");
    const toolUpdates = queuedToolUpdates(invocation.activityHooks);
    const consume = jsonLineConsumer((event) => {
      handleOpenCodeActivity(event, invocation.activityHooks, toolUpdates.emit);
    });
    const result = await runCommand(binary, args, {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5 * 60_000,
      env: safeProcessEnv(this.env),
      onStdout: consume.push,
    });
    consume.end();
    await toolUpdates.drain();
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
      messageId: invocation.trigger.id,
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
    const recentCalls: string[] = [];
    for (let turn = 0; turn <= 12; turn += 1) {
      const toolsEnabled = turn < 12;
      invocation.activityHooks?.status(
        "thinking",
        turn === 0 ? "Thinking" : "Reviewing tool results",
      );
      const payload = await this.providerRequest(
        agent,
        url,
        headers,
        {
          model: customProviderModel(agent),
          messages,
          stream: true,
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
        },
        invocation.activityHooks,
      );
      const calls = parseChatToolCalls(payload);
      if (calls.length === 0) return parseProviderReply(payload);
      if (!toolsEnabled) throw new Error("Provider continued calling tools after the step limit.");
      guardRepeatedCalls(calls, recentCalls);
      messages.push({
        role: "assistant",
        content: chatAssistantContent(payload),
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      const outputs = await Promise.all(calls.map((call) => tools.execute(call)));
      for (const [index, call] of calls.entries()) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: outputs[index] ?? "Tool completed without output.",
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
    const recentCalls: string[] = [];
    for (let turn = 0; turn <= 12; turn += 1) {
      const toolsEnabled = turn < 12;
      invocation.activityHooks?.status(
        "thinking",
        turn === 0 ? "Thinking" : "Reviewing tool results",
      );
      const payload = await this.providerRequest(
        agent,
        url,
        headers,
        {
          model: customProviderModel(agent),
          instructions: system,
          input,
          stream: true,
          ...(toolsEnabled ? { tools: tools.definitions } : { tool_choice: "none" }),
        },
        invocation.activityHooks,
      );
      const calls = parseResponsesToolCalls(payload);
      if (calls.length === 0) return parseProviderReply(payload);
      if (!toolsEnabled) throw new Error("Provider continued calling tools after the step limit.");
      guardRepeatedCalls(calls, recentCalls);
      if (isRecord(payload) && Array.isArray(payload.output)) input.push(...payload.output);
      const outputs = await Promise.all(calls.map((call) => tools.execute(call)));
      for (const [index, call] of calls.entries()) {
        input.push({
          type: "function_call_output",
          call_id: call.id,
          output: outputs[index] ?? "Tool completed without output.",
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
    activityHooks?: AgentActivityHooks,
  ): Promise<unknown> {
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(3 * 60_000),
        });
      } catch (error) {
        if (attempt >= 5) throw error;
        await retryDelay(attempt + 1);
        continue;
      }
      if (!response.ok) {
        const text = await readBoundedResponse(response, 1024 * 1024);
        if (attempt < 5 && isRetryableProviderStatus(response.status)) {
          await retryDelay(attempt + 1, response.headers);
          continue;
        }
        throw new Error(
          this.options.store.redactSecrets(
            `Provider ${customProviderName(agent)} returned HTTP ${response.status}: ${text.slice(0, 500)}`,
          ),
        );
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        return readProviderStream(
          response,
          agent.provider.type === "custom" ? agent.provider.protocol : "openai-responses",
          activityHooks,
        );
      }
      const text = await readBoundedResponse(response, 1024 * 1024);
      try {
        const payload = JSON.parse(text);
        const reply = parseProviderReply(payload);
        if (reply) activityHooks?.text(reply, "replace");
        return payload;
      } catch {
        throw new Error(`Provider ${customProviderName(agent)} did not return valid JSON.`);
      }
    }
    throw new Error(`Provider ${customProviderName(agent)} exhausted its retry budget.`);
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

async function readProviderStream(
  response: Response,
  protocol: "openai-chat" | "openai-responses",
  hooks?: AgentActivityHooks,
): Promise<unknown> {
  if (!response.body) throw new Error("Custom provider returned an empty stream.");
  const events: unknown[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  const consumeBlock = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore provider comments and malformed non-data diagnostics.
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Custom provider returned too much data.");
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const previousCount = events.length;
        consumeBlock(buffer.slice(0, boundary));
        if (events.length > previousCount) {
          streamProviderActivity(events.at(-1), protocol, hooks);
        }
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const previousCount = events.length;
      consumeBlock(buffer);
      if (events.length > previousCount) streamProviderActivity(events.at(-1), protocol, hooks);
    }
  } finally {
    reader.releaseLock();
  }
  return protocol === "openai-chat" ? assembleChatStream(events) : assembleResponsesStream(events);
}

function streamProviderActivity(
  event: unknown,
  protocol: "openai-chat" | "openai-responses",
  hooks?: AgentActivityHooks,
): void {
  if (!hooks || !isRecord(event)) return;
  if (protocol === "openai-chat") {
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!isRecord(choice) || !isRecord(choice.delta)) return;
    const delta = chatContentText(choice.delta.content);
    if (delta) {
      hooks.status("responding", "Writing a response");
      hooks.text(delta, "append");
    }
    return;
  }
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    hooks.status("responding", "Writing a response");
    hooks.text(event.delta, "append");
  }
}

function assembleChatStream(events: unknown[]): unknown {
  let content = "";
  let completedPayload: unknown;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for (const event of events) {
    if (!isRecord(event) || !Array.isArray(event.choices)) continue;
    completedPayload = event;
    const choice = event.choices[0];
    if (!isRecord(choice)) continue;
    if (isRecord(choice.message)) {
      const full = chatContentText(choice.message.content);
      if (full) content = full;
    }
    if (!isRecord(choice.delta)) continue;
    content += chatContentText(choice.delta.content);
    if (!Array.isArray(choice.delta.tool_calls)) continue;
    for (const rawCall of choice.delta.tool_calls) {
      if (!isRecord(rawCall)) continue;
      const index = typeof rawCall.index === "number" ? rawCall.index : calls.size;
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof rawCall.id === "string") call.id += rawCall.id;
      if (isRecord(rawCall.function)) {
        if (typeof rawCall.function.name === "string") call.name += rawCall.function.name;
        if (typeof rawCall.function.arguments === "string") {
          call.arguments += rawCall.function.arguments;
        }
      }
      calls.set(index, call);
    }
  }
  if (!content && calls.size === 0 && completedPayload) return completedPayload;
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(calls.size > 0
            ? {
                tool_calls: [...calls.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([, call], index) => ({
                    id: call.id || `call_${index}`,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
              }
            : {}),
        },
      },
    ],
  };
}

function assembleResponsesStream(events: unknown[]): unknown {
  let completed: unknown;
  let outputText = "";
  const output = new Map<number, Record<string, unknown>>();
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "response.completed" && isRecord(event.response)) {
      completed = event.response;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      outputText += event.delta;
    }
    const index = typeof event.output_index === "number" ? event.output_index : output.size;
    if (event.type === "response.output_item.added" && isRecord(event.item)) {
      output.set(index, { ...event.item });
    }
    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.delta === "string"
    ) {
      const item = output.get(index);
      if (item)
        item.arguments = `${typeof item.arguments === "string" ? item.arguments : ""}${event.delta}`;
    }
    if (event.type === "response.output_item.done" && isRecord(event.item)) {
      output.set(index, { ...event.item });
    }
  }
  if (completed) return completed;
  if (outputText) {
    output.set(-1, {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: outputText }],
    });
  }
  return { output_text: outputText, output: [...output.values()] };
}

function chatContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

function jsonLineConsumer(onEvent: (event: Record<string, unknown>) => void): {
  push: (chunk: string) => void;
  end: () => void;
} {
  let buffer = "";
  const consume = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (isRecord(event)) onEvent(event);
    } catch {
      // CLI diagnostics can be interleaved with the JSONL stream.
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consume(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    end() {
      consume(buffer);
      buffer = "";
    },
  };
}

function queuedToolUpdates(hooks?: AgentActivityHooks): {
  emit: (update: RuntimeToolUpdate) => void;
  drain: () => Promise<void>;
} {
  let queue = Promise.resolve();
  let failure: unknown;
  return {
    emit(update) {
      if (!hooks) return;
      queue = queue
        .then(() => hooks.tool(update))
        .catch((error) => {
          failure ??= error;
        });
    },
    async drain() {
      await queue;
      if (failure) throw failure;
    },
  };
}

function handleCodexActivity(
  event: Record<string, unknown>,
  hooks: AgentActivityHooks | undefined,
  emitTool: (update: RuntimeToolUpdate) => void,
): void {
  if (!hooks) return;
  const item = isRecord(event.item) ? event.item : undefined;
  if (!item) {
    if (event.type === "turn.started" || event.type === "thread.started") {
      hooks.status("thinking", "Thinking");
    }
    return;
  }
  const type = typeof item.type === "string" ? item.type : "activity";
  if (type === "agent_message") {
    if (typeof item.text === "string" && item.text) {
      hooks.status("responding", "Writing a response");
      hooks.text(item.text, "replace");
    }
    return;
  }
  if (type === "reasoning") {
    hooks.status("thinking", "Reasoning");
    return;
  }
  if (!isCodexToolItem(type)) {
    hooks.status("thinking", humanizeActivity(type));
    return;
  }
  const failed =
    item.status === "failed" ||
    item.status === "error" ||
    item.status === "declined" ||
    item.status === "cancelled" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0) ||
    Boolean(item.error);
  const completed = event.type === "item.completed" || item.status === "completed" || failed;
  const name = codexToolName(type, item);
  emitTool({
    id: typeof item.id === "string" ? item.id : `${type}-${crypto.randomUUID()}`,
    name,
    permission: permissionForTool(name, type),
    status: failed ? "failed" : completed ? "completed" : "running",
    input: compactJson(codexToolInput(type, item), 4_000),
    summary: failed ? undefined : codexToolSummary(type, item, completed),
    error: failed ? compactText(item.error ?? item.message ?? "Tool failed.", 2_000) : undefined,
  });
  hooks.status("tool", `${completed ? "Used" : "Using"} ${name}`);
}

function handleOpenCodeActivity(
  event: Record<string, unknown>,
  hooks: AgentActivityHooks | undefined,
  emitTool: (update: RuntimeToolUpdate) => void,
): void {
  if (!hooks) return;
  const part = isRecord(event.part) ? event.part : undefined;
  if (event.type === "step_start") {
    hooks.status("thinking", "Thinking");
    return;
  }
  if (event.type === "reasoning") {
    hooks.status("thinking", "Reasoning");
    return;
  }
  if (event.type === "text" && part?.type === "text" && typeof part.text === "string") {
    hooks.status("responding", "Writing a response");
    hooks.text(part.text, "replace");
    return;
  }
  if (event.type !== "tool_use" || part?.type !== "tool" || !isRecord(part.state)) return;
  const name = safeToolName(typeof part.tool === "string" ? part.tool : "tool");
  const failed = part.state.status === "error";
  emitTool({
    id: typeof part.id === "string" ? part.id : `tool-${crypto.randomUUID()}`,
    name,
    permission: permissionForTool(name),
    status: failed ? "failed" : "completed",
    input: compactJson(part.state.input ?? {}, 4_000),
    summary: failed ? undefined : compactText(part.state.title ?? "Tool completed.", 500),
    error: failed ? compactText(part.state.error ?? "Tool failed.", 2_000) : undefined,
  });
  hooks.status("tool", `${failed ? "Failed" : "Used"} ${name}`);
}

function isCodexToolItem(type: string): boolean {
  return [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "dynamic_tool_call",
    "collab_tool_call",
    "todo_list",
  ].includes(type);
}

function codexToolName(type: string, item: Record<string, unknown>): string {
  if (type === "command_execution") return "bash";
  if (type === "file_change") return "apply_patch";
  if (type === "web_search") return "websearch";
  if (type === "todo_list") return "todowrite";
  if (typeof item.tool === "string") return safeToolName(item.tool);
  if (typeof item.name === "string") return safeToolName(item.name);
  return safeToolName(type);
}

function codexToolInput(type: string, item: Record<string, unknown>): unknown {
  if (type === "command_execution") return { command: item.command };
  if (type === "web_search") return { query: item.query };
  return item.arguments ?? item.input ?? item.changes ?? {};
}

function codexToolSummary(type: string, item: Record<string, unknown>, completed: boolean): string {
  if (!completed) return "Tool started.";
  if (type === "command_execution" && typeof item.exit_code === "number") {
    return `Command exited with code ${item.exit_code}.`;
  }
  if (type === "file_change" && Array.isArray(item.changes)) {
    return `Applied ${item.changes.length} file change${item.changes.length === 1 ? "" : "s"}.`;
  }
  return "Tool completed.";
}

function permissionForTool(name: string, type?: string): HarnessPermissionKey {
  if (["list", "glob", "grep", "read"].includes(name)) return "read";
  if (["edit", "write", "apply_patch"].includes(name) || type === "file_change") return "edit";
  if (["bash", "command", "command_execution"].includes(name) || type === "command_execution") {
    return "bash";
  }
  if (name === "skill") return "skill";
  if (name === "todowrite" || name === "todo_list") return "todowrite";
  if (name === "webfetch") return "webfetch";
  if (name === "websearch" || type === "web_search") return "websearch";
  if (name === "question") return "question";
  return "external";
}

function safeToolName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100) || "tool"
  );
}

function humanizeActivity(value: string): string {
  const label = value.replace(/[_-]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function compactJson(value: unknown, limit: number): string {
  if (typeof value === "string") return compactText(value, limit);
  try {
    return compactText(JSON.stringify(value ?? {}), limit);
  } catch {
    return "{}";
  }
}

function compactText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : compactJsonFallback(value);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function compactJsonFallback(value: unknown): string {
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value);
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

function guardRepeatedCalls(calls: HarnessToolRequest[], recentCalls: string[]): void {
  for (const call of calls) {
    const signature = `${call.name}\n${canonicalArguments(call.arguments)}`;
    recentCalls.push(signature);
    if (recentCalls.length > 3) recentCalls.shift();
    if (recentCalls.length === 3 && recentCalls.every((recent) => recent === signature)) {
      throw new Error(`Stopped a repeated ${call.name} tool-call loop.`);
    }
  }
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function retryDelay(attempt: number, headers?: Headers): Promise<void> {
  const retryAfterMs = headers?.get("retry-after-ms");
  const retryAfter = headers?.get("retry-after");
  let delay = Number.NaN;
  if (retryAfterMs) delay = Number.parseFloat(retryAfterMs);
  else if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    delay = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1_000;
  }
  if (!Number.isFinite(delay) || delay < 0) {
    delay = Math.min(2_000 * 2 ** (attempt - 1), 30_000);
  }
  if (delay === 0) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(delay, 30_000)));
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
