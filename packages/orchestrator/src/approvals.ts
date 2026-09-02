/**
 * Approval gates (PLAN.md §4.2, §6).
 *
 * Creating an approval and waiting for it are the same operation as far as the
 * loop is concerned: the task pipeline stops until a human resolves the row.
 * The wait is driven by the store's own `approval.resolved` event, so anything
 * that resolves the approval — the REST route, a test, another process sharing
 * the database *through this store instance* — releases it.
 */
import type { Approval, ApprovalKind, HarnessConfig, RunSpec } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import type { ResolvedConfig } from "./config.js";

export class AbortedError extends Error {
  override readonly name = "AbortedError";
  constructor(message = "aborted") {
    super(message);
  }
}

export interface ApprovalRequest {
  threadId: string;
  kind: ApprovalKind;
  title: string;
  description?: string;
  risk?: Approval["risk"];
  taskId?: string;
  runId?: string;
}

/** Create an approval row and return it, without waiting. */
export function createApproval(store: NexestraStore, request: ApprovalRequest): Approval {
  return store.createApproval({
    threadId: request.threadId,
    kind: request.kind,
    title: request.title,
    ...(request.description ? { description: request.description } : {}),
    risk: request.risk ?? "low",
    ...(request.taskId ? { taskId: request.taskId } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
  });
}

/**
 * Resolve once the approval leaves `pending`.
 *
 * Subscribes *before* re-reading the row, so an approval resolved between the
 * create and the wait cannot be missed.
 */
export function waitForApproval(
  store: NexestraStore,
  approval: Approval,
  signal?: AbortSignal,
): Promise<Approval> {
  if (approval.status !== "pending") return Promise.resolve(approval);

  return new Promise<Approval>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => finish(() => reject(new AbortedError("approval wait aborted")));

    const unsubscribe = store.events.subscribe(approval.threadId, (event) => {
      if (event.type !== "approval.resolved") return;
      const payload = event.payload as Approval | undefined;
      if (!payload || payload.id !== approval.id) return;
      finish(() => resolve(payload));
    });

    if (signal?.aborted) {
      finish(() => reject(new AbortedError("approval wait aborted")));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    // Re-read: the row may have been resolved before we subscribed.
    const current = store.getApproval(approval.id);
    if (current && current.status !== "pending") finish(() => resolve(current));
  });
}

/** Create and wait in one step. */
export async function requestApproval(
  store: NexestraStore,
  request: ApprovalRequest,
  signal?: AbortSignal,
  onCreated?: (approval: Approval) => void,
): Promise<Approval> {
  const approval = createApproval(store, request);
  onCreated?.(approval);
  return waitForApproval(store, approval, signal);
}

/* --------------------------------------------------------------- the gate */

export interface GateDecision {
  /** True when the run may be spawned without asking. */
  allowed: boolean;
  kind?: ApprovalKind;
  title?: string;
  description?: string;
  risk?: Approval["risk"];
}

/**
 * Decide whether a run needs an approval before it is spawned.
 *
 * Two triggers, both from PLAN.md §4.2: an escalated sandbox, and reaching for
 * capability (MCP servers, tools) the workspace settings do not already grant.
 */
export function evaluateGate(
  spec: Pick<RunSpec, "sandbox" | "mcpServers" | "tools">,
  harnessConfig: Pick<HarnessConfig, "sandbox">,
  config: Pick<ResolvedConfig, "allowedMcpServers" | "allowedTools">,
): GateDecision {
  if (spec.sandbox === "danger-full-access") {
    return {
      allowed: false,
      kind: "sandbox_escalation",
      title: "Run with full disk and network access",
      description:
        "This run asks for the `danger-full-access` sandbox, which lets the harness read " +
        "and write anywhere on the machine and reach the network. The task's configured " +
        `sandbox is \`${harnessConfig.sandbox}\`.`,
      risk: "high",
    };
  }

  const allowedServers = new Set(config.allowedMcpServers);
  const servers = (spec.mcpServers ?? []).filter((server) => !allowedServers.has(server.name));
  if (servers.length > 0) {
    return {
      allowed: false,
      kind: "permission",
      title: `Allow ${servers.length} MCP server(s) for this run`,
      description:
        "The run requests MCP servers the workspace settings do not list:\n" +
        servers
          .map(
            (server) =>
              `- ${server.name} (${server.transport}${server.url ? ` ${server.url}` : ""}${
                server.command ? ` ${server.command}` : ""
              })`,
          )
          .join("\n"),
      risk: "high",
    };
  }

  if (config.allowedTools) {
    const allowedTools = new Set(config.allowedTools);
    const tools = (spec.tools ?? []).filter((tool) => !allowedTools.has(tool));
    if (tools.length > 0) {
      return {
        allowed: false,
        kind: "permission",
        title: `Allow ${tools.length} tool(s) for this run`,
        description: `The run requests tools the workspace settings do not list: ${tools.join(", ")}.`,
        risk: "high",
      };
    }
  }

  return { allowed: true };
}
