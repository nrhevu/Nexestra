import type { HarnessPermissionKey, ToolCall } from "../shared/contracts.js";

export interface MasterToolHooks {
  update(toolCall: ToolCall): Promise<void>;
  requestApproval(toolCall: ToolCall): Promise<boolean>;
  requestInput?(toolCall: ToolCall): Promise<string[][]>;
}

export interface MasterToolContext {
  agent: import("../shared/contracts.js").MasterAgent;
  runId: string;
  threadId: string;
  workspacePath: string;
  dataPath: string;
  readableArtifactPaths?: readonly string[];
  hooks?: MasterToolHooks;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  redact(value: string): string;
}

export interface HarnessToolRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition extends ProviderToolDefinition {
  permission: HarnessPermissionKey;
  parse(input: unknown): Promise<Record<string, unknown>>;
  execute(input: Record<string, unknown>, context: MasterToolContext): Promise<string>;
}
