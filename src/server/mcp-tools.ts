import { isAbsolute, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { HarnessConfig, McpServerConfig } from "./harness-config.js";
import { expandEnvironmentValue } from "./harness-config.js";
import type { MasterToolContext, ToolDefinition } from "./harness-tool-types.js";
import { safeProcessEnv } from "./process.js";

interface OpenClient {
  client: Client;
  close(): Promise<void>;
}

const MAX_MCP_RESPONSE_BYTES = 5 * 1024 * 1024;

interface RemoteMcpCall {
  url: string;
  headers?: Record<string, string>;
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export async function callRemoteMcpTool(options: RemoteMcpCall): Promise<string> {
  const client = new Client({ name: "nexestra", version: "0.1.0" });
  try {
    const transport = new StreamableHTTPClientTransport(validateRemoteUrl(options.url), {
      requestInit: { headers: options.headers },
      fetch: boundedMcpFetch(options.fetch ?? globalThis.fetch) as never,
    });
    await client.connect(transport, { timeout: options.timeoutMs });
    const result = await client.callTool(
      { name: options.name, arguments: options.arguments },
      { timeout: options.timeoutMs },
    );
    const output = mcpResultText(result);
    if (result.isError) throw new Error(output || `${options.name} returned an error.`);
    return output;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function loadMcpTools(
  config: HarnessConfig,
  context: MasterToolContext,
): Promise<{ tools: ToolDefinition[]; warnings: string[]; close(): Promise<void> }> {
  const clients: OpenClient[] = [];
  const tools: ToolDefinition[] = [];
  const warnings: string[] = [];
  for (const [serverName, server] of Object.entries(config.mcp.servers)) {
    if (server.disabled) continue;
    try {
      const timeout = mcpTimeouts(config.mcp.timeout, server.timeout);
      if (server.type === "remote" && server.oauth) {
        warnings.push(
          `MCP server ${serverName} has OAuth settings, but Nexestra cannot run its interactive OAuth flow.`,
        );
      }
      const open = await connectServer(server, context, timeout.startup);
      clients.push(open);
      const listed = await open.client.listTools(undefined, { timeout: timeout.catalog });
      for (const tool of listed.tools.slice(0, 200)) {
        const name = normalizeToolName(`${serverName}_${tool.name}`);
        tools.push({
          type: "function",
          name,
          description: (
            tool.description || `Tool ${tool.name} from MCP server ${serverName}.`
          ).slice(0, 2_000),
          parameters: asObject(tool.inputSchema),
          permission: "external",
          parse: async (input) => {
            if (!isRecord(input)) throw new Error("MCP tool arguments must be an object.");
            return input;
          },
          execute: async (input) => {
            const result = await open.client.callTool(
              { name: tool.name, arguments: input, _meta: { sessionID: context.runId } },
              { timeout: timeout.execution, toolDefinition: tool },
            );
            const output = mcpResultText(result);
            if (result.isError) throw new Error(output || `${name} returned an error.`);
            return output || "MCP tool completed without text output.";
          },
        });
      }
    } catch {
      warnings.push(`MCP server ${serverName} is unavailable.`);
    }
  }
  return {
    tools,
    warnings,
    close: async () => {
      await Promise.allSettled(clients.map((entry) => entry.close()));
    },
  };
}

async function connectServer(
  server: McpServerConfig,
  context: MasterToolContext,
  startupTimeout: number,
): Promise<OpenClient> {
  const client = new Client({ name: "nexestra", version: "0.1.0" });
  const sourceEnv = context.env ?? process.env;
  try {
    if (server.type === "local") {
      const [configuredCommand, ...args] = server.command;
      if (!configuredCommand) throw new Error("Local MCP command is empty.");
      const command =
        isAbsolute(configuredCommand) || configuredCommand.includes("/")
          ? resolve(context.workspacePath, configuredCommand)
          : configuredCommand;
      const inherited = definedEnvironment(safeProcessEnv(sourceEnv));
      const configured = Object.fromEntries(
        Object.entries(server.environment).map(([key, value]) => [
          key,
          expandEnvironmentValue(value, sourceEnv),
        ]),
      );
      const cwd = server.cwd
        ? resolveInsideWorkspace(context.workspacePath, server.cwd)
        : context.workspacePath;
      const transport = new StdioClientTransport({
        command,
        args,
        cwd,
        env: { ...inherited, ...configured },
        stderr: "pipe",
        maxBufferSize: 1024 * 1024,
      });
      transport.stderr?.on("data", () => undefined);
      await client.connect(transport, { timeout: startupTimeout });
      return { client, close: () => client.close() };
    }

    const url = validateRemoteUrl(server.url);
    const headers = Object.fromEntries(
      Object.entries(server.headers).map(([key, value]) => [
        key,
        expandEnvironmentValue(value, sourceEnv),
      ]),
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: boundedMcpFetch(context.fetch ?? globalThis.fetch) as never,
    });
    await client.connect(transport, { timeout: startupTimeout });
    return { client, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function mcpTimeouts(
  defaults: { startup: number; catalog: number; execution: number },
  override: McpServerConfig["timeout"],
): { startup: number; catalog: number; execution: number } {
  if (typeof override === "number") {
    return { startup: override, catalog: override, execution: override };
  }
  return {
    startup: override?.startup ?? defaults.startup,
    catalog: override?.catalog ?? defaults.catalog,
    execution: override?.execution ?? defaults.execution,
  };
}

function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error("Remote MCP URLs must not contain user info or fragments.");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new Error("Remote MCP servers must use HTTPS unless they run on localhost.");
}

function resolveInsideWorkspace(workspacePath: string, value: string): string {
  const resolved = resolve(workspacePath, value);
  if (resolved !== workspacePath && !resolved.startsWith(`${workspacePath}/`)) {
    throw new Error("MCP cwd must stay inside the repository.");
  }
  return resolved;
}

function mcpResultText(result: unknown): string {
  if (!isRecord(result)) return "";
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (
        item.type === "resource" &&
        isRecord(item.resource) &&
        typeof item.resource.text === "string"
      ) {
        parts.push(item.resource.text);
      } else if (item.type === "image" || item.type === "audio") {
        parts.push(`[${item.type} content omitted]`);
      }
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { type: "object", properties: {} };
}

function normalizeToolName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || "mcp_tool").slice(0, 64);
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.startsWith("127.")
  );
}

function boundedMcpFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || init?.method === "GET") return response;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
      await response.body.cancel();
      throw new Error("MCP response is too large.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MCP_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("MCP response is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
