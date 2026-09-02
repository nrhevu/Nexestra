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
} from "../shared/contracts.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";
import type { FileStore } from "./store.js";

export interface AgentInvocation {
  thread: Thread;
  trigger: Message;
  transcriptPath: string;
  transcriptSnapshot: string;
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
      message: codex.installed ? "Chưa đăng nhập ChatGPT." : "Chưa cài Codex CLI.",
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
        message: connected ? output || "Đã kết nối ChatGPT." : output || "Chưa đăng nhập ChatGPT.",
      };
    }
    const value: RuntimeStatus = {
      chatgpt,
      harnesses: {
        codex: { installed: codex.installed, version: codex.version },
        opencode: { installed: opencode.installed, version: opencode.version },
      },
    };
    this.cachedStatus = { value, expiresAt: Date.now() + 5_000 };
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
    if (!binary) throw new Error("Không tìm thấy Codex CLI trong PATH.");
    const runDirectory = join(this.options.store.root, "runs", crypto.randomUUID());
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const lastMessageFile = join(runDirectory, "last-message.txt");
    const prompt = localHarnessPrompt(agent, invocation);
    const args = [
      "exec",
      "--json",
      "-C",
      this.options.store.workspacePath,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-o",
      lastMessageFile,
    ];
    if (agent.kind === "master" && agent.provider.type === "chatgpt" && agent.provider.model) {
      args.push("-m", agent.provider.model);
    }
    args.push(prompt);
    const result = await runCommand(binary, args, {
      cwd: this.options.store.workspacePath,
      timeoutMs: 5 * 60_000,
      env: safeProcessEnv(this.env),
    });
    if (result.exitCode !== 0) {
      throw new Error(cleanProcessError(result.stderr || result.stdout, "Codex đã dừng với lỗi."));
    }
    const fileReply = await readFile(lastMessageFile, "utf8").catch(() => "");
    const reply = fileReply.trim() || parseCodexReply(result.stdout);
    if (!reply) throw new Error("Codex không trả về nội dung cuối.");
    return reply;
  }

  private async invokeOpenCode(agent: Agent, invocation: AgentInvocation): Promise<string> {
    const binary = await findExecutable("opencode", this.env);
    if (!binary) throw new Error("Không tìm thấy OpenCode trong PATH.");
    const result = await runCommand(
      binary,
      [
        "run",
        "--format",
        "json",
        "--pure",
        "--agent",
        "plan",
        "--dir",
        this.options.store.workspacePath,
        "--file",
        invocation.transcriptPath,
        localHarnessPrompt(agent, invocation),
      ],
      {
        cwd: this.options.store.workspacePath,
        timeoutMs: 5 * 60_000,
        env: safeProcessEnv(this.env),
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        cleanProcessError(result.stderr || result.stdout, "OpenCode đã dừng với lỗi."),
      );
    }
    const reply = parseOpenCodeReply(result.stdout);
    if (!reply) throw new Error("OpenCode không trả về nội dung cuối.");
    return reply;
  }

  private async invokeCustom(agent: MasterAgent, invocation: AgentInvocation): Promise<string> {
    if (agent.provider.type !== "custom") throw new Error("Provider không hợp lệ.");
    const url = providerEndpoint(agent.provider.baseUrl, agent.provider.protocol);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const credential = this.options.store.getCredential(agent.id);
    if (credential) headers.authorization = `Bearer ${credential}`;
    const system = [
      `Bạn là ${agent.name} (@${agent.handle}), Master agent nội bộ của Nexestra.`,
      "Bạn đang trả lời trong một thread chung với người dùng và các agent khác.",
      "Hãy trả lời đúng câu vừa @mention bạn, ngắn gọn, có hành động cụ thể, bằng ngôn ngữ của người dùng.",
      agent.instructions,
    ]
      .filter(Boolean)
      .join("\n\n");
    const body =
      agent.provider.protocol === "openai-chat"
        ? {
            model: agent.provider.model,
            messages: [
              { role: "system", content: system },
              {
                role: "user",
                content: providerUserPrompt(invocation),
              },
            ],
          }
        : {
            model: agent.provider.model,
            instructions: system,
            input: providerUserPrompt(invocation),
          };
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3 * 60_000),
    });
    const text = await readBoundedResponse(response, 1024 * 1024);
    if (!response.ok) {
      throw new Error(
        `Provider ${agent.provider.name} trả về HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Provider ${agent.provider.name} không trả về JSON hợp lệ.`);
    }
    const reply = parseProviderReply(payload);
    if (!reply) throw new Error(`Provider ${agent.provider.name} không có nội dung trả lời.`);
    if (reply.length > 40_000) {
      throw new Error(`Provider ${agent.provider.name} trả về câu trả lời quá dài.`);
    }
    return reply;
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
  let readinessLabel = "Sẵn sàng";
  if (!agent.enabled || agent.archived) {
    readiness = "disabled";
    readinessLabel = agent.archived ? "Đã lưu trữ" : "Đã tắt";
  } else if (busyAgentIds.has(agent.id)) {
    readiness = "busy";
    readinessLabel = "Đang trả lời";
  } else if (agent.kind === "worker" && !runtime.harnesses[agent.harness].installed) {
    readiness = "unavailable";
    readinessLabel = `Chưa cài ${agent.harness === "codex" ? "Codex" : "OpenCode"}`;
  } else if (agent.kind === "master" && agent.provider.type === "chatgpt") {
    if (!runtime.chatgpt.installed || !runtime.chatgpt.connected) {
      readiness = "needs_setup";
      readinessLabel = runtime.chatgpt.installed ? "Cần đăng nhập" : "Chưa cài Codex CLI";
    }
  }
  return { ...agent, readiness, readinessLabel };
}

function localHarnessPrompt(agent: Agent, invocation: AgentInvocation): string {
  const role = agent.kind === "master" ? "Master agent" : `${agent.harness} worker`;
  return [
    `Bạn là ${agent.name} (@${agent.handle}), ${role} trong Nexestra.`,
    `Người dùng vừa gọi bạn trong thread #${invocation.thread.slug}.`,
    `Message bắt buộc phải trả lời (id: ${invocation.trigger.id}):\n${invocation.trigger.content}`,
    "Hãy trả lời đúng message trên, kể cả khi transcript có message mới hơn.",
    `Transcript chung nằm tại: ${invocation.transcriptPath}`,
    "Hãy đọc transcript để lấy ngữ cảnh liên quan.",
    "Đây là lượt thảo luận: không sửa file, không chạy lệnh thay đổi trạng thái.",
    "Chỉ trả về nội dung câu trả lời để Nexestra ghi vào thread.",
    agent.instructions ? `Chỉ dẫn riêng:\n${agent.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function providerUserPrompt(invocation: AgentInvocation): string {
  return [
    `Message bắt buộc phải trả lời (id: ${invocation.trigger.id}):`,
    invocation.trigger.content,
    "Hãy trả lời đúng message trên, kể cả khi transcript có message mới hơn.",
    `Transcript chung của #${invocation.thread.slug}:`,
    invocation.transcriptSnapshot,
  ].join("\n\n");
}

function providerEndpoint(baseUrl: string, protocol: "openai-chat" | "openai-responses"): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Custom provider chỉ hỗ trợ URL http hoặc https.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Base URL không được chứa user info, query string hoặc fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Remote custom provider phải dùng HTTPS.");
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
    throw new Error("Custom provider trả về quá nhiều dữ liệu.");
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
        throw new Error("Custom provider trả về quá nhiều dữ liệu.");
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
    if (isRecord(first) && isRecord(first.message) && typeof first.message.content === "string") {
      return first.message.content.trim();
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

function cleanProcessError(output: string, fallback: string): string {
  const cleaned = output.trim();
  return cleaned ? cleaned.slice(-2_000) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
