import {
  mockApprovals,
  mockArtifacts,
  mockMemories,
  mockMessages,
  mockPlans,
  mockRunEvents,
  mockRuns,
  mockSpecs,
  mockTasks,
  mockThreads,
  mockWorkspaces,
} from "@nexestra/core/mock";
import type { NexestraStore } from "./store.js";

/**
 * Load the `@nexestra/core` fixtures into a store so a fresh install has demo
 * content. Every row goes through a command, so the event log is populated too
 * and a rebuild reproduces exactly what was seeded.
 *
 * Idempotent: a store that already has a workspace is left untouched.
 */
export function seedMock(store: NexestraStore, options: { force?: boolean } = {}): boolean {
  if (!options.force && store.listWorkspaces().length > 0) return false;

  store.events.transaction(() => {
    for (const workspace of mockWorkspaces) {
      store.createWorkspace({
        id: workspace.id,
        name: workspace.name,
        rootPath: workspace.rootPath,
        shortLabel: workspace.shortLabel,
        defaultBranch: workspace.defaultBranch,
        settings: workspace.settings,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      });
    }

    for (const thread of mockThreads) {
      store.createThread({
        id: thread.id,
        workspaceId: thread.workspaceId,
        title: thread.title,
        phase: thread.phase,
        summary: thread.summary,
        specId: thread.specId,
        planId: thread.planId,
        budgetUSD: thread.budgetUSD,
        costUSD: thread.costUSD,
        lastActivityAt: thread.lastActivityAt,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    }

    for (const spec of mockSpecs) {
      store.upsertSpec(spec.threadId, {
        id: spec.id,
        version: spec.version,
        goal: spec.goal,
        scope: spec.scope,
        constraints: spec.constraints,
        expectedOutcome: spec.expectedOutcome,
        acceptanceCriteria: spec.acceptanceCriteria,
        openQuestions: spec.openQuestions,
        decisions: spec.decisions,
        frozen: spec.frozen,
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt,
      });
    }

    for (const plan of mockPlans) {
      store.upsertPlan(plan.threadId, {
        id: plan.id,
        specId: plan.specId,
        version: plan.version,
        summary: plan.summary,
        taskIds: plan.taskIds,
        edges: plan.edges,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      });
    }

    for (const task of mockTasks) {
      store.createTask({
        id: task.id,
        threadId: task.threadId,
        planId: task.planId,
        title: task.title,
        description: task.description,
        dependsOn: task.dependsOn,
        assignedHarness: task.assignedHarness,
        harnessConfig: task.harnessConfig,
        status: task.status,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        acceptanceCriteriaIds: task.acceptanceCriteriaIds,
        costUSD: task.costUSD,
        order: task.order,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }

    for (const run of mockRuns) {
      store.recordRun({
        id: run.id,
        threadId: run.threadId,
        taskId: run.taskId,
        kind: run.kind,
        harness: run.harness,
        sessionRef: run.sessionRef,
        worktreePath: run.worktreePath,
        status: run.status,
        exitCode: run.exitCode,
        usage: run.usage,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    }

    for (const runEvent of mockRunEvents) {
      store.appendRunEvent({
        id: runEvent.id,
        runId: runEvent.runId,
        seq: runEvent.seq,
        type: runEvent.type,
        payload: runEvent.payload,
        createdAt: runEvent.createdAt,
      });
    }

    for (const artifact of mockArtifacts) {
      store.recordArtifact({
        id: artifact.id,
        threadId: artifact.threadId,
        taskId: artifact.taskId,
        runId: artifact.runId,
        kind: artifact.kind,
        title: artifact.title,
        path: artifact.path,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        preview: artifact.preview,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      });
    }

    for (const approval of mockApprovals) {
      store.createApproval({
        id: approval.id,
        threadId: approval.threadId,
        taskId: approval.taskId,
        runId: approval.runId,
        kind: approval.kind,
        title: approval.title,
        description: approval.description,
        risk: approval.risk,
        status: approval.status,
        requestedAt: approval.requestedAt,
        resolvedAt: approval.resolvedAt,
        resolvedBy: approval.resolvedBy,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
      });
    }

    for (const message of mockMessages) {
      store.addMessage({
        id: message.id,
        threadId: message.threadId,
        role: message.role,
        content: message.content,
        references: message.references,
        toolCalls: message.toolCalls,
        attachments: message.attachments,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      });
    }

    // Nodes first: a link is rejected unless both endpoints already exist.
    for (const memory of mockMemories) {
      store.upsertMemory({
        id: memory.id,
        workspaceId: memory.workspaceId,
        threadId: memory.threadId,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        source: memory.source,
        tags: memory.tags,
        authoredBy: memory.authoredBy,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      });
    }

    for (const memory of mockMemories) {
      for (const link of memory.links) {
        store.linkMemories(memory.id, {
          targetId: link.targetId,
          type: link.type,
          note: link.note,
          createdAt: memory.updatedAt,
        });
      }
    }

    const first = mockWorkspaces[0];
    if (first) {
      store.putSettings({
        defaultHarness: first.settings.defaultHarness,
        // Deliberately not `first.settings.defaultModel`: the demo workspace
        // names a model for illustration, but the machine-wide default has to
        // stay `HARNESS_DEFAULT_MODEL` — a seeded install must not hand every
        // account a model name its harness might reject.
        budgetUSD: first.settings.budgetUSD,
        concurrency: first.settings.concurrency,
        defaultSandbox: first.settings.defaultSandbox,
      });
    }
  });

  return true;
}
