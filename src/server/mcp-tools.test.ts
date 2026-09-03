import { describe, expect, it, vi } from "vitest";
import type { MasterAgent } from "../shared/contracts.js";
import { HarnessConfigSchema } from "./harness-config.js";
import type { MasterToolContext } from "./harness-tool-types.js";

const sdk = vi.hoisted(() => ({
  connected: [] as unknown[],
  called: [] as unknown[],
  closed: 0,
  transports: [] as { kind: string; input: unknown }[],
}));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    async connect(transport: unknown) {
      sdk.connected.push(transport);
    }
    async listTools() {
      return {
        tools: [
          {
            name: "lookup",
            description: "Look something up.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      };
    }
    async callTool(input: unknown) {
      sdk.called.push(input);
      return { content: [{ type: "text", text: "MCP result" }] };
    }
    async close() {
      sdk.closed += 1;
    }
  },
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      sdk.transports.push({ kind: "remote", input: { url: url.toString(), options } });
    }
  },
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    stderr = { on: vi.fn() };
    constructor(options: unknown) {
      sdk.transports.push({ kind: "local", input: options });
    }
  },
}));

import { loadMcpTools } from "./mcp-tools.js";

describe("MCP tools", () => {
  it("discovers, prefixes, invokes, and closes local and remote server tools", async () => {
    const config = HarnessConfigSchema.parse({
      mcp: {
        servers: {
          localdocs: {
            type: "local",
            command: ["node", "server.mjs"],
            environment: { TOKEN: "{env:TEST_MCP_TOKEN}" },
          },
          remotedocs: {
            type: "remote",
            url: "https://mcp.example.test/service",
            headers: { authorization: "Bearer $" + "{TEST_MCP_TOKEN}" },
          },
        },
      },
    });
    const loaded = await loadMcpTools(config, toolContext());

    expect(loaded.warnings).toEqual([]);
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      "localdocs_lookup",
      "remotedocs_lookup",
    ]);
    await expect(loaded.tools[0]?.execute({ value: "guide" }, toolContext())).resolves.toBe(
      "MCP result",
    );
    expect(sdk.called).toContainEqual(
      expect.objectContaining({ name: "lookup", arguments: { value: "guide" } }),
    );
    expect(sdk.transports).toContainEqual(
      expect.objectContaining({
        kind: "local",
        input: expect.objectContaining({ env: expect.objectContaining({ TOKEN: "token-value" }) }),
      }),
    );
    await loaded.close();
    expect(sdk.closed).toBe(2);
  });
});

function toolContext(): MasterToolContext {
  const now = new Date().toISOString();
  const agent: MasterAgent = {
    id: "master",
    workspaceId: "workspace",
    kind: "master",
    name: "Master",
    handle: "master",
    description: "",
    instructions: "",
    enabled: true,
    archived: false,
    accessMode: "full",
    provider: {
      type: "custom",
      name: "Test",
      baseUrl: "https://provider.example/v1",
      model: "model",
      protocol: "openai-chat",
      hasCredential: false,
    },
    createdAt: now,
    updatedAt: now,
  };
  return {
    agent,
    runId: "run",
    threadId: "thread",
    workspacePath: "/tmp/repository",
    dataPath: "/tmp/repository/.nexestra",
    env: { PATH: process.env.PATH, HOME: "/tmp", TEST_MCP_TOKEN: "token-value" },
    fetch,
    redact: (value) => value.replaceAll("token-value", "[REDACTED]"),
  };
}
