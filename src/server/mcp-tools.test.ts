import { describe, expect, it, vi } from "vitest";
import type { MasterAgent } from "../shared/contracts.js";
import { HarnessConfigSchema } from "./harness-config.js";
import type { MasterToolContext } from "./harness-tool-types.js";

const sdk = vi.hoisted(() => ({
  connected: [] as unknown[],
  connectOptions: [] as unknown[],
  catalogOptions: [] as unknown[],
  called: [] as unknown[],
  callOptions: [] as unknown[],
  resourceReads: [] as unknown[],
  resourceReadOptions: [] as unknown[],
  promptReads: [] as unknown[],
  promptReadOptions: [] as unknown[],
  closed: 0,
  transports: [] as { kind: string; input: unknown }[],
}));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    async connect(transport: unknown, options: unknown) {
      sdk.connected.push(transport);
      sdk.connectOptions.push(options);
    }
    async listTools(_input: unknown, options: unknown) {
      sdk.catalogOptions.push(options);
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
    async listResources(_input: unknown, options: unknown) {
      sdk.catalogOptions.push(options);
      return {
        resources: [
          {
            uri: "docs://guide",
            name: "Guide",
            description: "A guide.",
            mimeType: "text/plain",
          },
        ],
      };
    }
    async listPrompts(_input: unknown, options: unknown) {
      sdk.catalogOptions.push(options);
      return {
        prompts: [
          {
            name: "summarize",
            description: "Summarize a document.",
            arguments: [{ name: "topic", description: "Topic", required: true }],
          },
        ],
      };
    }
    async callTool(input: unknown, options: unknown) {
      sdk.called.push(input);
      sdk.callOptions.push(options);
      return { content: [{ type: "text", text: "MCP result" }] };
    }
    async readResource(input: unknown, options: unknown) {
      sdk.resourceReads.push(input);
      sdk.resourceReadOptions.push(options);
      return {
        contents: [{ uri: "docs://guide", mimeType: "text/plain", text: "Resource body" }],
      };
    }
    async getPrompt(input: unknown, options: unknown) {
      sdk.promptReads.push(input);
      sdk.promptReadOptions.push(options);
      return {
        description: "Expanded prompt",
        messages: [{ role: "user", content: { type: "text", text: "Summarize this topic." } }],
      };
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
        timeout: { startup: 40_000, catalog: 41_000, execution: 42_000 },
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
            timeout: { startup: 45_000, execution: 46_000 },
          },
        },
      },
    });
    const loaded = await loadMcpTools(config, toolContext());

    expect(loaded.warnings).toEqual([]);
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      "localdocs_lookup",
      "localdocs_read_mcp_resource",
      "localdocs_get_mcp_prompt",
      "remotedocs_lookup",
      "remotedocs_read_mcp_resource",
      "remotedocs_get_mcp_prompt",
    ]);
    await expect(loaded.tools[0]?.execute({ value: "guide" }, toolContext())).resolves.toBe(
      "MCP result",
    );
    expect(sdk.called).toContainEqual(
      expect.objectContaining({ name: "lookup", arguments: { value: "guide" } }),
    );
    expect(sdk.connectOptions).toEqual([{ timeout: 40_000 }, { timeout: 45_000 }]);
    expect(sdk.catalogOptions).toEqual([
      { timeout: 41_000 },
      { timeout: 41_000 },
      { timeout: 41_000 },
      { timeout: 41_000 },
      { timeout: 41_000 },
      { timeout: 41_000 },
    ]);
    expect(sdk.callOptions).toContainEqual(expect.objectContaining({ timeout: 42_000 }));
    const resourceTool = loaded.tools.find((tool) => tool.name === "localdocs_read_mcp_resource");
    expect(resourceTool?.description).toContain("docs://guide");
    await expect(resourceTool?.execute({ uri: "docs://guide" }, toolContext())).resolves.toBe(
      "Resource body",
    );
    expect(sdk.resourceReads).toContainEqual({ uri: "docs://guide" });
    expect(sdk.resourceReadOptions).toContainEqual(expect.objectContaining({ timeout: 42_000 }));
    await expect(resourceTool?.execute({ uri: "docs://unknown" }, toolContext())).rejects.toThrow(
      "not in the catalog",
    );
    const promptTool = loaded.tools.find((tool) => tool.name === "localdocs_get_mcp_prompt");
    expect(promptTool?.description).toContain("summarize");
    await expect(
      promptTool?.execute(
        { name: "summarize", arguments: { topic: "reliability" } },
        toolContext(),
      ),
    ).resolves.toBe("Summarize this topic.");
    expect(sdk.promptReads).toContainEqual({
      name: "summarize",
      arguments: { topic: "reliability" },
    });
    expect(sdk.promptReadOptions).toContainEqual(expect.objectContaining({ timeout: 42_000 }));
    await expect(promptTool?.execute({ name: "unknown" }, toolContext())).rejects.toThrow(
      "not in the catalog",
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
