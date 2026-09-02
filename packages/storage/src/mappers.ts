import type {
  Approval,
  Artifact,
  Memory,
  MemoryLink,
  Message,
  NexestraEvent,
  Plan,
  Run,
  RunEvent,
  Spec,
  Task,
  Thread,
  Workspace,
} from "@nexestra/core";
import type {
  ApprovalRow,
  ArtifactRow,
  EventRow,
  MemoryLinkRow,
  MemoryRow,
  MessageRow,
  PlanRow,
  RunEventRow,
  RunRow,
  SpecRow,
  TaskRow,
  ThreadRow,
  WorkspaceRow,
} from "./schema.js";

/** SQLite gives back `null` where the domain schemas expect `undefined`. */
const opt = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    shortLabel: row.shortLabel,
    defaultBranch: row.defaultBranch,
    settings: row.settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromWorkspace(workspace: Workspace): WorkspaceRow {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPath: workspace.rootPath,
    shortLabel: workspace.shortLabel,
    defaultBranch: workspace.defaultBranch,
    settings: workspace.settings,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    phase: row.phase,
    summary: row.summary,
    specId: opt(row.specId),
    planId: opt(row.planId),
    budgetUSD: row.budgetUSD,
    costUSD: row.costUSD,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromThread(thread: Thread): ThreadRow {
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    title: thread.title,
    phase: thread.phase,
    summary: thread.summary,
    specId: thread.specId ?? null,
    planId: thread.planId ?? null,
    budgetUSD: thread.budgetUSD,
    costUSD: thread.costUSD,
    lastActivityAt: thread.lastActivityAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    references: row.references,
    toolCalls: row.toolCalls,
    attachments: row.attachments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromMessage(message: Message): MessageRow {
  return { ...message };
}

export function toSpec(row: SpecRow): Spec {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    version: row.version,
    goal: row.goal,
    scope: row.scope,
    constraints: row.constraints,
    expectedOutcome: row.expectedOutcome,
    acceptanceCriteria: row.acceptanceCriteria,
    openQuestions: row.openQuestions,
    decisions: row.decisions,
    frozen: row.frozen,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromSpec(spec: Spec): SpecRow {
  return { ...spec };
}

export function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    specId: row.specId,
    version: row.version,
    summary: row.summary,
    taskIds: row.taskIds,
    edges: row.edges,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromPlan(plan: Plan): PlanRow {
  return { ...plan };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    planId: row.planId,
    title: row.title,
    description: row.description,
    dependsOn: row.dependsOn,
    assignedHarness: opt(row.assignedHarness),
    harnessConfig: row.harnessConfig,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    acceptanceCriteriaIds: row.acceptanceCriteriaIds,
    costUSD: row.costUSD,
    mergeState: opt(row.mergeState),
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromTask(task: Task): TaskRow {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    threadId: task.threadId,
    planId: task.planId,
    title: task.title,
    description: task.description,
    dependsOn: task.dependsOn,
    assignedHarness: task.assignedHarness ?? null,
    harnessConfig: task.harnessConfig,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    acceptanceCriteriaIds: task.acceptanceCriteriaIds,
    costUSD: task.costUSD,
    mergeState: task.mergeState ?? null,
    order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    taskId: row.taskId,
    kind: row.kind,
    harness: row.harness,
    sessionRef: opt(row.sessionRef),
    worktreePath: opt(row.worktreePath),
    status: row.status,
    exitCode: opt(row.exitCode),
    usage: row.usage,
    startedAt: row.startedAt,
    endedAt: opt(row.endedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromRun(run: Run): RunRow {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    taskId: run.taskId,
    kind: run.kind,
    harness: run.harness,
    sessionRef: run.sessionRef ?? null,
    worktreePath: run.worktreePath ?? null,
    status: run.status,
    exitCode: run.exitCode ?? null,
    usage: run.usage,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

export function fromRunEvent(event: RunEvent): RunEventRow {
  return { ...event };
}

export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    taskId: opt(row.taskId),
    runId: opt(row.runId),
    kind: row.kind,
    title: row.title,
    path: row.path,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    preview: row.preview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromArtifact(artifact: Artifact): ArtifactRow {
  return {
    ...artifact,
    taskId: artifact.taskId ?? null,
    runId: artifact.runId ?? null,
  };
}

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    taskId: opt(row.taskId),
    runId: opt(row.runId),
    kind: row.kind as Approval["kind"],
    title: row.title,
    description: row.description,
    risk: row.risk,
    status: row.status as Approval["status"],
    requestedAt: row.requestedAt,
    resolvedAt: opt(row.resolvedAt),
    resolvedBy: opt(row.resolvedBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromApproval(approval: Approval): ApprovalRow {
  return {
    ...approval,
    taskId: approval.taskId ?? null,
    runId: approval.runId ?? null,
    resolvedAt: approval.resolvedAt ?? null,
    resolvedBy: approval.resolvedBy ?? null,
  };
}

export function toMemory(row: MemoryRow, links: readonly MemoryLink[]): Memory {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: opt(row.threadId),
    type: row.type,
    title: row.title,
    content: row.content,
    links: [...links],
    source: opt(row.source),
    tags: row.tags,
    authoredBy: row.authoredBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function fromMemory(memory: Memory): MemoryRow {
  return {
    id: memory.id,
    workspaceId: memory.workspaceId,
    threadId: memory.threadId ?? null,
    type: memory.type,
    title: memory.title,
    content: memory.content,
    source: memory.source ?? null,
    tags: memory.tags,
    authoredBy: memory.authoredBy,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function toMemoryLink(row: MemoryLinkRow): MemoryLink {
  return { type: row.type, targetId: row.targetId, note: row.note };
}

export function toEvent(row: EventRow): NexestraEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: opt(row.threadId),
    runId: opt(row.runId),
    seq: row.seq,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}
