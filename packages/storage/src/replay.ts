import type {
  Approval,
  Artifact,
  Memory,
  MemoryLinkType,
  Message,
  NexestraEvent,
  Plan,
  Run,
  RunEvent,
  Spec,
  Task,
  Thread,
} from "@nexestra/core";
import { and, eq, inArray } from "drizzle-orm";
import {
  fromApproval,
  fromArtifact,
  fromMemory,
  fromMessage,
  fromPlan,
  fromRun,
  fromRunEvent,
  fromSpec,
  fromTask,
  fromThread,
} from "./mappers.js";
import * as t from "./schema.js";
import type { NexestraStore } from "./store.js";

/**
 * Replay a thread's event log into the projection tables.
 *
 * Entity events carry the full post-state of the entity, so applying one is a
 * plain upsert; the only bookkeeping the replayer repeats is what the commands
 * do outside the entity row itself (`threads.specId` / `planId` and the
 * `lastActivityAt` touch), and it uses the same timestamps to stay bit-exact.
 *
 * Memories with no `threadId` are workspace-scoped and are neither cleared nor
 * replayed here.
 */
export function rebuildProjections(store: NexestraStore, threadId: string): number {
  const events = store.events.readThread(threadId);
  if (events.length === 0) return 0;

  return store.events.transaction(() => {
    clearThread(store, threadId);
    for (const event of events) applyEvent(store, event);
    return events.length;
  });
}

function clearThread(store: NexestraStore, threadId: string): void {
  const { db } = store;

  const memoryIds = db
    .select({ id: t.memories.id })
    .from(t.memories)
    .where(eq(t.memories.threadId, threadId))
    .all()
    .map((row) => row.id);

  if (memoryIds.length > 0) {
    db.delete(t.memoryLinks).where(inArray(t.memoryLinks.sourceId, memoryIds)).run();
    db.delete(t.memories).where(inArray(t.memories.id, memoryIds)).run();
  }

  db.delete(t.runEvents).where(eq(t.runEvents.threadId, threadId)).run();
  db.delete(t.runs).where(eq(t.runs.threadId, threadId)).run();
  db.delete(t.artifacts).where(eq(t.artifacts.threadId, threadId)).run();
  db.delete(t.approvals).where(eq(t.approvals.threadId, threadId)).run();
  db.delete(t.tasks).where(eq(t.tasks.threadId, threadId)).run();
  db.delete(t.plans).where(eq(t.plans.threadId, threadId)).run();
  db.delete(t.specs).where(eq(t.specs.threadId, threadId)).run();
  db.delete(t.messages).where(eq(t.messages.threadId, threadId)).run();
  db.delete(t.threads).where(eq(t.threads.id, threadId)).run();
}

function applyEvent(store: NexestraStore, event: NexestraEvent): void {
  const { db } = store;

  switch (event.type) {
    case "thread.created":
    case "thread.updated":
    case "thread.phase_changed": {
      const row = fromThread(event.payload as Thread);
      db.insert(t.threads).values(row).onConflictDoUpdate({ target: t.threads.id, set: row }).run();
      break;
    }

    case "message.added": {
      const message = event.payload as Message;
      const row = fromMessage(message);
      db.insert(t.messages)
        .values(row)
        .onConflictDoUpdate({ target: t.messages.id, set: row })
        .run();
      touch(store, message.threadId, message.createdAt);
      break;
    }

    case "spec.upserted":
    case "spec.frozen": {
      const spec = event.payload as Spec;
      const row = fromSpec(spec);
      db.insert(t.specs).values(row).onConflictDoUpdate({ target: t.specs.id, set: row }).run();
      db.update(t.threads).set({ specId: spec.id }).where(eq(t.threads.id, spec.threadId)).run();
      touch(store, spec.threadId, spec.updatedAt);
      break;
    }

    case "plan.upserted": {
      const plan = event.payload as Plan;
      const row = fromPlan(plan);
      db.insert(t.plans).values(row).onConflictDoUpdate({ target: t.plans.id, set: row }).run();
      db.update(t.threads).set({ planId: plan.id }).where(eq(t.threads.id, plan.threadId)).run();
      touch(store, plan.threadId, plan.updatedAt);
      break;
    }

    case "task.created":
    case "task.updated":
    case "task.status_changed": {
      const task = event.payload as Task;
      const row = fromTask(task);
      db.insert(t.tasks).values(row).onConflictDoUpdate({ target: t.tasks.id, set: row }).run();
      touch(store, task.threadId, task.updatedAt);
      break;
    }

    case "task.reordered": {
      const payload = event.payload as { threadId: string; taskIds: string[]; updatedAt: string };
      payload.taskIds.forEach((taskId, index) => {
        db.update(t.tasks)
          .set({ order: index, updatedAt: payload.updatedAt })
          .where(and(eq(t.tasks.id, taskId), eq(t.tasks.threadId, payload.threadId)))
          .run();
      });
      break;
    }

    case "task.deleted": {
      const payload = event.payload as { id: string };
      db.delete(t.tasks).where(eq(t.tasks.id, payload.id)).run();
      break;
    }

    case "run.recorded": {
      const run = event.payload as Run;
      const row = fromRun(run);
      db.insert(t.runs).values(row).onConflictDoUpdate({ target: t.runs.id, set: row }).run();
      touch(store, run.threadId, run.updatedAt);
      break;
    }

    case "run.event_appended": {
      const runEvent = event.payload as RunEvent;
      const row = fromRunEvent(runEvent);
      db.insert(t.runEvents)
        .values(row)
        .onConflictDoUpdate({ target: t.runEvents.id, set: row })
        .run();
      break;
    }

    case "artifact.recorded": {
      const row = fromArtifact(event.payload as Artifact);
      db.insert(t.artifacts)
        .values(row)
        .onConflictDoUpdate({ target: t.artifacts.id, set: row })
        .run();
      break;
    }

    case "approval.requested":
    case "approval.resolved": {
      const row = fromApproval(event.payload as Approval);
      db.insert(t.approvals)
        .values(row)
        .onConflictDoUpdate({ target: t.approvals.id, set: row })
        .run();
      break;
    }

    case "memory.upserted": {
      const row = fromMemory(event.payload as Memory);
      db.insert(t.memories)
        .values(row)
        .onConflictDoUpdate({ target: t.memories.id, set: row })
        .run();
      break;
    }

    case "memory.deleted": {
      const payload = event.payload as { id: string };
      db.delete(t.memoryLinks).where(eq(t.memoryLinks.sourceId, payload.id)).run();
      db.delete(t.memoryLinks).where(eq(t.memoryLinks.targetId, payload.id)).run();
      db.delete(t.memories).where(eq(t.memories.id, payload.id)).run();
      break;
    }

    case "memory.linked": {
      const row = event.payload as typeof t.memoryLinks.$inferInsert;
      db.insert(t.memoryLinks)
        .values(row)
        .onConflictDoUpdate({
          target: [t.memoryLinks.sourceId, t.memoryLinks.targetId, t.memoryLinks.type],
          set: { note: row.note ?? "" },
        })
        .run();
      break;
    }

    case "memory.unlinked": {
      const payload = event.payload as {
        sourceId: string;
        targetId: string;
        type: MemoryLinkType;
      };
      db.delete(t.memoryLinks)
        .where(
          and(
            eq(t.memoryLinks.sourceId, payload.sourceId),
            eq(t.memoryLinks.targetId, payload.targetId),
            eq(t.memoryLinks.type, payload.type),
          ),
        )
        .run();
      break;
    }

    case "workspace.created":
    case "workspace.updated":
    case "agent.created":
    case "agent.updated":
    case "agent.deleted":
    case "settings.updated":
      // Workspace-level state is not part of a thread rebuild.
      break;

    case "master.started":
    case "master.text_delta":
    case "master.tool_call":
    case "master.tool_result":
    case "master.question":
    case "master.usage":
    case "master.error":
    case "master.done":
      // Narration of a Master turn: no projection row hangs off it. The durable
      // results of the turn arrive as ordinary entity events.
      break;

    case "orchestrator.progress":
    case "orchestrator.status_changed":
      // Narration of the execution loop (M6). Same story: the runs, tasks,
      // artifacts and approvals it produced are their own entity events.
      break;

    default: {
      const exhaustive: never = event.type;
      throw new Error(`unhandled event type ${String(exhaustive)}`);
    }
  }
}

function touch(store: NexestraStore, threadId: string, at: string): void {
  store.db
    .update(t.threads)
    .set({ lastActivityAt: at, updatedAt: at })
    .where(eq(t.threads.id, threadId))
    .run();
}
