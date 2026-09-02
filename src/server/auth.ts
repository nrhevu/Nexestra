import { type ChildProcess, spawn } from "node:child_process";
import { findExecutable, safeProcessEnv, stopProcess } from "./process.js";
import type { LocalAgentRunner } from "./runtime.js";
import type { FileStore } from "./store.js";

export interface LoginSessionView {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string;
  connected: boolean;
}

interface LoginSession extends LoginSessionView {
  child?: ChildProcess;
}

export class ChatGptAuthManager {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly store: FileStore,
    private readonly runner: LocalAgentRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(): Promise<LoginSessionView> {
    const active = [...this.sessions.values()].find((session) => session.status === "running");
    if (active) return this.view(active);
    this.runner.clearStatusCache();
    const runtime = await this.runner.runtimeStatus();
    if (runtime.chatgpt.connected) {
      const session: LoginSession = {
        id: crypto.randomUUID(),
        status: "completed",
        output: runtime.chatgpt.message,
        connected: true,
      };
      this.sessions.set(session.id, session);
      return this.view(session);
    }
    const binary = await findExecutable("codex", this.env);
    if (!binary) throw new Error("Cần cài Codex CLI trước khi kết nối ChatGPT.");
    const child = spawn(binary, ["login", "--device-auth"], {
      cwd: this.store.workspacePath,
      env: safeProcessEnv(this.env),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const session: LoginSession = {
      id: crypto.randomUUID(),
      status: "running",
      output: "Đang khởi tạo đăng nhập ChatGPT…",
      connected: false,
      child,
    };
    this.sessions.set(session.id, session);
    const append = (chunk: Buffer) => {
      session.output = cleanOutput(`${session.output}\n${chunk.toString("utf8")}`).slice(-16_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      session.status = "failed";
      session.output = `${session.output}\n${error.message}`;
      session.child = undefined;
    });
    child.on("close", (code) => {
      if (session.status === "cancelled") return;
      session.status = code === 0 ? "completed" : "failed";
      session.child = undefined;
      this.runner.clearStatusCache();
    });
    return this.view(session);
  }

  async get(id: string): Promise<LoginSessionView | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.runner.clearStatusCache();
    const runtime = await this.runner.runtimeStatus();
    session.connected = runtime.chatgpt.connected;
    if (session.connected && session.status === "running") {
      if (session.child) stopProcess(session.child.pid);
      session.child = undefined;
      session.status = "completed";
    }
    return this.view(session);
  }

  cancel(id: string): LoginSessionView | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.child) stopProcess(session.child.pid);
    session.child = undefined;
    session.status = "cancelled";
    session.output = `${session.output}\nĐã hủy đăng nhập.`;
    return this.view(session);
  }

  private view(session: LoginSession): LoginSessionView {
    return {
      id: session.id,
      status: session.status,
      output: session.output,
      connected: session.connected,
    };
  }
}

function cleanOutput(value: string): string {
  return value.trim();
}
