import {
  type Approval,
  ApprovalSchema,
  type AppSettings,
  AppSettingsSchema,
  type Artifact,
  ArtifactSchema,
  DEFAULT_APP_SETTINGS,
  type HarnessEventType,
  type Memory,
  type MemoryLink,
  type MemoryLinkType,
  MemorySchema,
  type Message,
  MessageSchema,
  type NexestraEvent,
  type Plan,
  PlanSchema,
  type Run,
  type RunEvent,
  RunEventSchema,
  RunSchema,
  type Spec,
  SpecSchema,
  type Task,
  TaskSchema,
  type Thread,
  type ThreadPhase,
  ThreadSchema,
  type Workspace,
  WorkspaceSchema,
  WorkspaceSettingsSchema,
} from "@nexestra/core";
import type Database from "better-sqlite3";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { type NexestraDatabase, type OpenDatabaseOptions, openDatabase } from "./db.js";
import { EventStore } from "./event-store.js";
import { newId, now } from "./ids.js";
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
  fromWorkspace,
  toApproval,
  toArtifact,
  toMemory,
  toMemoryLink,
  toMessage,
  toPlan,
  toRun,
  toRunEvent,
  toSpec,
  toTask,
  toThread,
  toWorkspace,
} from "./mappers.js";
import { dataDirectory, nexestraHome } from "./paths.js";
import * as t from "./schema.js";

/** Thrown when a command references a row that is not there. */
export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

const SETTINGS_KEY = "app";

export interface CreateStoreOptions extends OpenDatabaseOptions {
  /** Root for artifact bytes; defaults to `<NEXESTRA_HOME>/data`. */
  dataDir?: string;
}

/**
 * The whole persistence surface: reads straight off the projection tables and
 * commands that write a projection and its event in one transaction.
 */
export class NexestraStore {
  readonly events: EventStore;

  constructor(
    readonly db: NexestraDatabase,
    readonly sqlite: Database.Database,
    readonly file: string,
    readonly dataDir: string,
  ) {
    this.events = new EventStore(db, sqlite);
  }

  close(): void {
    this.sqlite.close();
  }

  // ------------------------------------------------------------ workspaces

  listWorkspaces(): Workspace[] {
    return this.db
      .select()
      .from(t.workspaces)
      .orderBy(asc(t.workspaces.createdAt))
      .all()
      .map(toWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.select().from(t.workspaces).where(eq(t.workspaces.id, id)).get();
    return row ? toWorkspace(row) : null;
  }

  createWorkspace(input: {
    name: string;
    rootPath: string;
    shortLabel?: string;
    defaultBranch?: string;
    settings?: Partial<Workspace["settings"]>;
    id?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Workspace {
    const at = input.createdAt ?? now();
    const workspace = WorkspaceSchema.parse({
      id: input.id ?? newId("ws"),
      name: input.name,
      rootPath: input.rootPath,
      shortLabel: input.shortLabel ?? shortLabelFor(input.name),
      defaultBranch: input.defaultBranch ?? "main",
      settings: WorkspaceSettingsSchema.parse(input.settings ?? {}),
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      this.db.insert(t.workspaces).values(fromWorkspace(workspace)).run();
      this.events.append({
        workspaceId: workspace.id,
        type: "workspace.created",
        payload: workspace,
        createdAt: workspace.createdAt,
      });
      return workspace;
    });
  }

  updateWorkspace(
    id: string,
    patch: {
      name?: string;
      shortLabel?: string;
      defaultBranch?: string;
      settings?: Partial<Workspace["settings"]>;
    },
  ): Workspace {
    const current = this.getWorkspace(id);
    if (!current) throw new NotFoundError("workspace", id);

    const workspace = WorkspaceSchema.parse({
      ...current,
      ...stripUndefined({
        name: patch.name,
        shortLabel: patch.shortLabel,
        defaultBranch: patch.defaultBranch,
      }),
      settings: patch.settings
        ? WorkspaceSettingsSchema.parse({ ...current.settings, ...patch.settings })
        : current.settings,
      updatedAt: now(),
    });

    return this.events.transaction(() => {
      this.db
        .update(t.workspaces)
        .set(fromWorkspace(workspace))
        .where(eq(t.workspaces.id, id))
        .run();
      this.events.append({
        workspaceId: id,
        type: "workspace.updated",
        payload: workspace,
      });
      return workspace;
    });
  }

  // --------------------------------------------------------------- threads

  listThreads(workspaceId?: string): Thread[] {
    const query = this.db.select().from(t.threads);
    const rows = workspaceId
      ? query.where(eq(t.threads.workspaceId, workspaceId)).orderBy(asc(t.threads.createdAt)).all()
      : query.orderBy(asc(t.threads.createdAt)).all();
    return rows.map(toThread);
  }

  getThread(id: string): Thread | null {
    const row = this.db.select().from(t.threads).where(eq(t.threads.id, id)).get();
    return row ? toThread(row) : null;
  }

  createThread(input: {
    workspaceId: string;
    title: string;
    summary?: string;
    phase?: ThreadPhase;
    budgetUSD?: number;
    id?: string;
    specId?: string;
    planId?: string;
    costUSD?: number;
    createdAt?: string;
    updatedAt?: string;
    lastActivityAt?: string;
  }): Thread {
    if (!this.getWorkspace(input.workspaceId)) {
      throw new NotFoundError("workspace", input.workspaceId);
    }
    const at = input.createdAt ?? now();
    const thread = ThreadSchema.parse({
      id: input.id ?? newId("th"),
      workspaceId: input.workspaceId,
      title: input.title,
      phase: input.phase ?? "intake",
      summary: input.summary ?? "",
      specId: input.specId,
      planId: input.planId,
      budgetUSD: input.budgetUSD ?? this.getSettings().budgetUSD,
      costUSD: input.costUSD ?? 0,
      lastActivityAt: input.lastActivityAt ?? at,
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      this.db.insert(t.threads).values(fromThread(thread)).run();
      // `threadId` is set so the event is seq 0 of the thread's own log and a
      // rebuild can recreate the row. Clients subscribed to the workspace see
      // it too, because a workspace subscription matches `event.workspaceId`.
      this.events.append({
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        type: "thread.created",
        payload: thread,
        createdAt: thread.createdAt,
      });
      return thread;
    });
  }

  updateThread(
    id: string,
    patch: {
      title?: string;
      summary?: string;
      phase?: ThreadPhase;
      budgetUSD?: number;
      costUSD?: number;
      specId?: string;
      planId?: string;
    },
  ): Thread {
    const current = this.getThread(id);
    if (!current) throw new NotFoundError("thread", id);

    const at = now();
    const thread = ThreadSchema.parse({
      ...current,
      ...stripUndefined(patch),
      updatedAt: at,
      lastActivityAt: at,
    });
    const phaseChanged = patch.phase !== undefined && patch.phase !== current.phase;

    return this.events.transaction(() => {
      this.db.update(t.threads).set(fromThread(thread)).where(eq(t.threads.id, id)).run();
      this.events.append({
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        type: phaseChanged ? "thread.phase_changed" : "thread.updated",
        payload: thread,
      });
      return thread;
    });
  }

  // -------------------------------------------------------------- messages

  listMessages(threadId: string): Message[] {
    return this.db
      .select()
      .from(t.messages)
      .where(eq(t.messages.threadId, threadId))
      .orderBy(asc(t.messages.createdAt), asc(t.messages.id))
      .all()
      .map(toMessage);
  }

  addMessage(input: {
    threadId: string;
    role?: Message["role"];
    content: string;
    references?: Message["references"];
    toolCalls?: Message["toolCalls"];
    attachments?: Message["attachments"];
    id?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Message {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new NotFoundError("thread", input.threadId);

    const at = input.createdAt ?? now();
    const message = MessageSchema.parse({
      id: input.id ?? newId("msg"),
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      role: input.role ?? "user",
      content: input.content,
      references: input.references ?? [],
      toolCalls: input.toolCalls ?? [],
      attachments: input.attachments ?? [],
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      this.db.insert(t.messages).values(fromMessage(message)).run();
      this.touchThread(thread.id, message.createdAt);
      this.events.append({
        workspaceId: message.workspaceId,
        threadId: message.threadId,
        type: "message.added",
        payload: message,
        createdAt: message.createdAt,
      });
      return message;
    });
  }

  // ------------------------------------------------------------ spec / plan

  getSpec(threadId: string): Spec | null {
    const row = this.db
      .select()
      .from(t.specs)
      .where(eq(t.specs.threadId, threadId))
      .orderBy(desc(t.specs.version))
      .get();
    return row ? toSpec(row) : null;
  }

  upsertSpec(
    threadId: string,
    patch: Partial<Omit<Spec, "id" | "workspaceId" | "threadId" | "createdAt" | "updatedAt">> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Spec {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);

    const current = this.getSpec(threadId);
    const at = patch.updatedAt ?? now();
    const spec = SpecSchema.parse({
      id: patch.id ?? current?.id ?? newId("spec"),
      workspaceId: thread.workspaceId,
      threadId,
      version: patch.version ?? (current ? current.version + 1 : 1),
      goal: patch.goal ?? current?.goal ?? "",
      scope: patch.scope ?? current?.scope ?? { in: [], out: [] },
      constraints: patch.constraints ?? current?.constraints ?? [],
      expectedOutcome: patch.expectedOutcome ?? current?.expectedOutcome ?? "",
      acceptanceCriteria: patch.acceptanceCriteria ?? current?.acceptanceCriteria ?? [],
      openQuestions: patch.openQuestions ?? current?.openQuestions ?? [],
      decisions: patch.decisions ?? current?.decisions ?? [],
      frozen: patch.frozen ?? current?.frozen ?? false,
      createdAt: patch.createdAt ?? current?.createdAt ?? at,
      updatedAt: at,
    });
    const froze = spec.frozen && !current?.frozen;

    return this.events.transaction(() => {
      const row = fromSpec(spec);
      this.db
        .insert(t.specs)
        .values(row)
        .onConflictDoUpdate({ target: t.specs.id, set: row })
        .run();
      if (thread.specId !== spec.id) {
        this.db.update(t.threads).set({ specId: spec.id }).where(eq(t.threads.id, threadId)).run();
      }
      this.touchThread(threadId, spec.updatedAt);
      this.events.append({
        workspaceId: spec.workspaceId,
        threadId,
        type: froze ? "spec.frozen" : "spec.upserted",
        payload: spec,
        createdAt: spec.updatedAt,
      });
      return spec;
    });
  }

  getPlan(threadId: string): Plan | null {
    const row = this.db
      .select()
      .from(t.plans)
      .where(eq(t.plans.threadId, threadId))
      .orderBy(desc(t.plans.version))
      .get();
    return row ? toPlan(row) : null;
  }

  upsertPlan(
    threadId: string,
    patch: {
      specId?: string;
      summary?: string;
      taskIds?: string[];
      edges?: Plan["edges"];
      version?: number;
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Plan {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);

    const current = this.getPlan(threadId);
    const specId = patch.specId ?? current?.specId ?? thread.specId;
    if (!specId) throw new NotFoundError("spec for thread", threadId);

    const at = patch.updatedAt ?? now();
    const plan = PlanSchema.parse({
      id: patch.id ?? current?.id ?? newId("plan"),
      workspaceId: thread.workspaceId,
      threadId,
      specId,
      version: patch.version ?? (current ? current.version + 1 : 1),
      summary: patch.summary ?? current?.summary ?? "",
      taskIds: patch.taskIds ?? current?.taskIds ?? [],
      edges: patch.edges ?? current?.edges ?? [],
      createdAt: patch.createdAt ?? current?.createdAt ?? at,
      updatedAt: at,
    });

    return this.events.transaction(() => {
      const row = fromPlan(plan);
      this.db
        .insert(t.plans)
        .values(row)
        .onConflictDoUpdate({ target: t.plans.id, set: row })
        .run();
      if (thread.planId !== plan.id) {
        this.db.update(t.threads).set({ planId: plan.id }).where(eq(t.threads.id, threadId)).run();
      }
      this.touchThread(threadId, plan.updatedAt);
      this.events.append({
        workspaceId: plan.workspaceId,
        threadId,
        type: "plan.upserted",
        payload: plan,
        createdAt: plan.updatedAt,
      });
      return plan;
    });
  }

  // ----------------------------------------------------------------- tasks

  listTasks(threadId: string): Task[] {
    return this.db
      .select()
      .from(t.tasks)
      .where(eq(t.tasks.threadId, threadId))
      .orderBy(asc(t.tasks.order), asc(t.tasks.createdAt))
      .all()
      .map(toTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.select().from(t.tasks).where(eq(t.tasks.id, id)).get();
    return row ? toTask(row) : null;
  }

  createTask(input: {
    threadId: string;
    title: string;
    planId?: string;
    description?: string;
    dependsOn?: string[];
    assignedHarness?: Task["assignedHarness"];
    harnessConfig?: Partial<Task["harnessConfig"]>;
    status?: Task["status"];
    attempts?: number;
    maxAttempts?: number;
    acceptanceCriteriaIds?: string[];
    costUSD?: number;
    order?: number;
    id?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Task {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new NotFoundError("thread", input.threadId);

    const planId = input.planId ?? thread.planId ?? this.ensurePlan(thread).id;
    const at = input.createdAt ?? now();
    const order = input.order ?? this.listTasks(input.threadId).length;

    const task = TaskSchema.parse({
      id: input.id ?? newId("task"),
      workspaceId: thread.workspaceId,
      threadId: thread.id,
      planId,
      title: input.title,
      description: input.description ?? "",
      dependsOn: input.dependsOn ?? [],
      assignedHarness: input.assignedHarness,
      harnessConfig: input.harnessConfig ?? {},
      status: input.status ?? "todo",
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      acceptanceCriteriaIds: input.acceptanceCriteriaIds ?? [],
      costUSD: input.costUSD ?? 0,
      order,
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      this.db.insert(t.tasks).values(fromTask(task)).run();
      this.touchThread(thread.id, task.updatedAt);
      this.events.append({
        workspaceId: task.workspaceId,
        threadId: task.threadId,
        type: "task.created",
        payload: task,
        createdAt: task.createdAt,
      });
      return task;
    });
  }

  updateTask(
    id: string,
    patch: Partial<Omit<Task, "id" | "workspaceId" | "threadId" | "createdAt" | "updatedAt">>,
  ): Task {
    const current = this.getTask(id);
    if (!current) throw new NotFoundError("task", id);

    const task = TaskSchema.parse({
      ...current,
      ...stripUndefined(patch),
      harnessConfig: patch.harnessConfig
        ? { ...current.harnessConfig, ...patch.harnessConfig }
        : current.harnessConfig,
      updatedAt: now(),
    });
    const statusChanged = patch.status !== undefined && patch.status !== current.status;

    return this.events.transaction(() => {
      this.db.update(t.tasks).set(fromTask(task)).where(eq(t.tasks.id, id)).run();
      this.touchThread(task.threadId, task.updatedAt);
      this.events.append({
        workspaceId: task.workspaceId,
        threadId: task.threadId,
        type: statusChanged ? "task.status_changed" : "task.updated",
        payload: task,
      });
      return task;
    });
  }

  /** Board drag: move a card to another column, optionally at a position. */
  updateTaskStatus(id: string, status: Task["status"], order?: number): Task {
    return this.updateTask(id, order === undefined ? { status } : { status, order });
  }

  /** Persist a manual ordering; the index in `taskIds` becomes `Task.order`. */
  reorderTasks(threadId: string, taskIds: readonly string[]): Task[] {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);

    const at = now();
    return this.events.transaction(() => {
      taskIds.forEach((taskId, index) => {
        this.db
          .update(t.tasks)
          .set({ order: index, updatedAt: at })
          .where(and(eq(t.tasks.id, taskId), eq(t.tasks.threadId, threadId)))
          .run();
      });
      this.events.append({
        workspaceId: thread.workspaceId,
        threadId,
        type: "task.reordered",
        payload: { threadId, taskIds: [...taskIds], updatedAt: at },
        createdAt: at,
      });
      return this.listTasks(threadId);
    });
  }

  deleteTask(id: string): void {
    const current = this.getTask(id);
    if (!current) throw new NotFoundError("task", id);

    this.events.transaction(() => {
      this.db.delete(t.tasks).where(eq(t.tasks.id, id)).run();
      this.events.append({
        workspaceId: current.workspaceId,
        threadId: current.threadId,
        type: "task.deleted",
        payload: { id, threadId: current.threadId },
      });
    });
  }

  // ------------------------------------------------------------------ runs

  listRuns(threadId: string): Run[] {
    return this.db
      .select()
      .from(t.runs)
      .where(eq(t.runs.threadId, threadId))
      .orderBy(asc(t.runs.startedAt))
      .all()
      .map(toRun);
  }

  getRun(id: string): Run | null {
    const row = this.db.select().from(t.runs).where(eq(t.runs.id, id)).get();
    return row ? toRun(row) : null;
  }

  /** Insert or update a run row (dispatch, progress, completion). */
  recordRun(input: {
    id?: string;
    threadId: string;
    taskId: string;
    kind: Run["kind"];
    harness: Run["harness"];
    status?: Run["status"];
    sessionRef?: string;
    worktreePath?: string;
    exitCode?: number;
    usage?: Partial<Run["usage"]>;
    startedAt?: string;
    endedAt?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Run {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new NotFoundError("thread", input.threadId);

    const current = input.id ? this.getRun(input.id) : null;
    const at = input.updatedAt ?? now();
    const run = RunSchema.parse({
      id: input.id ?? newId("run"),
      workspaceId: thread.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      kind: input.kind,
      harness: input.harness,
      sessionRef: input.sessionRef ?? current?.sessionRef,
      worktreePath: input.worktreePath ?? current?.worktreePath,
      status: input.status ?? current?.status ?? "pending",
      exitCode: input.exitCode ?? current?.exitCode,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        ...current?.usage,
        ...input.usage,
      },
      startedAt: input.startedAt ?? current?.startedAt ?? at,
      endedAt: input.endedAt ?? current?.endedAt,
      createdAt: input.createdAt ?? current?.createdAt ?? at,
      updatedAt: at,
    });

    return this.events.transaction(() => {
      const row = fromRun(run);
      this.db.insert(t.runs).values(row).onConflictDoUpdate({ target: t.runs.id, set: row }).run();
      this.touchThread(run.threadId, run.updatedAt);
      this.events.append({
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
        type: "run.recorded",
        payload: run,
        createdAt: run.updatedAt,
      });
      return run;
    });
  }

  listRunEvents(runId: string, afterSeq?: number): RunEvent[] {
    const base = eq(t.runEvents.runId, runId);
    const where = afterSeq === undefined ? base : and(base, gt(t.runEvents.seq, afterSeq));
    return this.db
      .select()
      .from(t.runEvents)
      .where(where)
      .orderBy(asc(t.runEvents.seq))
      .all()
      .map(toRunEvent);
  }

  /** Append one normalised `HarnessEvent` to a run. */
  appendRunEvent(input: {
    runId: string;
    type: HarnessEventType;
    payload: unknown;
    id?: string;
    seq?: number;
    createdAt?: string;
  }): RunEvent {
    const run = this.getRun(input.runId);
    if (!run) throw new NotFoundError("run", input.runId);

    const seq = input.seq ?? this.listRunEvents(input.runId).length;
    const runEvent = RunEventSchema.parse({
      id: input.id ?? newId("rev"),
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      runId: run.id,
      seq,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? now(),
    });

    return this.events.transaction(() => {
      this.db.insert(t.runEvents).values(fromRunEvent(runEvent)).run();
      this.events.append({
        workspaceId: runEvent.workspaceId,
        threadId: runEvent.threadId,
        runId: runEvent.runId,
        type: "run.event_appended",
        payload: runEvent,
        createdAt: runEvent.createdAt,
      });
      return runEvent;
    });
  }

  // ------------------------------------------------------------- artifacts

  listArtifacts(threadId: string): Artifact[] {
    return this.db
      .select()
      .from(t.artifacts)
      .where(eq(t.artifacts.threadId, threadId))
      .orderBy(asc(t.artifacts.createdAt))
      .all()
      .map(toArtifact);
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.select().from(t.artifacts).where(eq(t.artifacts.id, id)).get();
    return row ? toArtifact(row) : null;
  }

  recordArtifact(input: {
    threadId: string;
    kind: Artifact["kind"];
    title: string;
    path: string;
    taskId?: string;
    runId?: string;
    mimeType?: string;
    sizeBytes?: number;
    preview?: string;
    id?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Artifact {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new NotFoundError("thread", input.threadId);

    const at = input.createdAt ?? now();
    const artifact = ArtifactSchema.parse({
      id: input.id ?? newId("art"),
      workspaceId: thread.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      title: input.title,
      path: input.path,
      mimeType: input.mimeType ?? "text/plain",
      sizeBytes: input.sizeBytes ?? 0,
      preview: input.preview ?? "",
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      const row = fromArtifact(artifact);
      this.db
        .insert(t.artifacts)
        .values(row)
        .onConflictDoUpdate({ target: t.artifacts.id, set: row })
        .run();
      this.events.append({
        workspaceId: artifact.workspaceId,
        threadId: artifact.threadId,
        runId: artifact.runId,
        type: "artifact.recorded",
        payload: artifact,
        createdAt: artifact.createdAt,
      });
      return artifact;
    });
  }

  // ------------------------------------------------------------- approvals

  listApprovals(
    filter: { workspaceId?: string; threadId?: string; status?: string } = {},
  ): Approval[] {
    const clauses = [
      filter.workspaceId ? eq(t.approvals.workspaceId, filter.workspaceId) : undefined,
      filter.threadId ? eq(t.approvals.threadId, filter.threadId) : undefined,
      filter.status ? eq(t.approvals.status, filter.status) : undefined,
    ].filter((clause) => clause !== undefined);

    const query = this.db.select().from(t.approvals);
    const rows =
      clauses.length > 0
        ? query
            .where(and(...clauses))
            .orderBy(asc(t.approvals.requestedAt))
            .all()
        : query.orderBy(asc(t.approvals.requestedAt)).all();
    return rows.map(toApproval);
  }

  getApproval(id: string): Approval | null {
    const row = this.db.select().from(t.approvals).where(eq(t.approvals.id, id)).get();
    return row ? toApproval(row) : null;
  }

  createApproval(input: {
    threadId: string;
    kind: Approval["kind"];
    title: string;
    description?: string;
    risk?: Approval["risk"];
    taskId?: string;
    runId?: string;
    status?: Approval["status"];
    id?: string;
    requestedAt?: string;
    resolvedAt?: string;
    resolvedBy?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Approval {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new NotFoundError("thread", input.threadId);

    const at = input.createdAt ?? now();
    const approval = ApprovalSchema.parse({
      id: input.id ?? newId("apr"),
      workspaceId: thread.workspaceId,
      threadId: input.threadId,
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      title: input.title,
      description: input.description ?? "",
      risk: input.risk ?? "low",
      status: input.status ?? "pending",
      requestedAt: input.requestedAt ?? at,
      resolvedAt: input.resolvedAt,
      resolvedBy: input.resolvedBy,
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
    });

    return this.events.transaction(() => {
      this.db.insert(t.approvals).values(fromApproval(approval)).run();
      this.events.append({
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        runId: approval.runId,
        type: "approval.requested",
        payload: approval,
        createdAt: approval.createdAt,
      });
      return approval;
    });
  }

  resolveApproval(
    id: string,
    input: { status: Exclude<Approval["status"], "pending">; resolvedBy?: string },
  ): Approval {
    const current = this.getApproval(id);
    if (!current) throw new NotFoundError("approval", id);

    const at = now();
    const approval = ApprovalSchema.parse({
      ...current,
      status: input.status,
      resolvedAt: at,
      resolvedBy: input.resolvedBy ?? "user",
      updatedAt: at,
    });

    return this.events.transaction(() => {
      this.db.update(t.approvals).set(fromApproval(approval)).where(eq(t.approvals.id, id)).run();
      this.events.append({
        workspaceId: approval.workspaceId,
        threadId: approval.threadId,
        runId: approval.runId,
        type: "approval.resolved",
        payload: approval,
        createdAt: at,
      });
      return approval;
    });
  }

  // -------------------------------------------------------------- memories

  listMemories(filter: { workspaceId?: string; threadId?: string } = {}): Memory[] {
    const clauses = [
      filter.workspaceId ? eq(t.memories.workspaceId, filter.workspaceId) : undefined,
      filter.threadId ? eq(t.memories.threadId, filter.threadId) : undefined,
    ].filter((clause) => clause !== undefined);

    const query = this.db.select().from(t.memories);
    const rows =
      clauses.length > 0
        ? query
            .where(and(...clauses))
            .orderBy(asc(t.memories.createdAt))
            .all()
        : query.orderBy(asc(t.memories.createdAt)).all();
    if (rows.length === 0) return [];

    const links = this.db
      .select()
      .from(t.memoryLinks)
      .where(
        inArray(
          t.memoryLinks.sourceId,
          rows.map((row) => row.id),
        ),
      )
      .all();

    const bySource = new Map<string, MemoryLink[]>();
    for (const link of links) {
      const list = bySource.get(link.sourceId) ?? [];
      list.push(toMemoryLink(link));
      bySource.set(link.sourceId, list);
    }
    return rows.map((row) => toMemory(row, bySource.get(row.id) ?? []));
  }

  getMemory(id: string): Memory | null {
    const row = this.db.select().from(t.memories).where(eq(t.memories.id, id)).get();
    if (!row) return null;
    const links = this.db
      .select()
      .from(t.memoryLinks)
      .where(eq(t.memoryLinks.sourceId, id))
      .all()
      .map(toMemoryLink);
    return toMemory(row, links);
  }

  /** Create or replace a memory node. Links are managed by `linkMemories`. */
  upsertMemory(input: {
    workspaceId: string;
    id?: string;
    threadId?: string;
    type: Memory["type"];
    title: string;
    content?: string;
    source?: Memory["source"];
    tags?: string[];
    authoredBy?: Memory["authoredBy"];
    createdAt?: string;
    updatedAt?: string;
  }): Memory {
    const existing = input.id ? this.getMemory(input.id) : null;
    const at = input.updatedAt ?? now();
    const memory = MemorySchema.parse({
      id: input.id ?? newId("mem"),
      workspaceId: input.workspaceId,
      threadId: input.threadId ?? existing?.threadId,
      type: input.type,
      title: input.title,
      content: input.content ?? existing?.content ?? "",
      links: existing?.links ?? [],
      source: input.source ?? existing?.source,
      tags: input.tags ?? existing?.tags ?? [],
      authoredBy: input.authoredBy ?? existing?.authoredBy ?? "master",
      createdAt: input.createdAt ?? existing?.createdAt ?? at,
      updatedAt: at,
    });

    return this.events.transaction(() => {
      const row = fromMemory(memory);
      this.db
        .insert(t.memories)
        .values(row)
        .onConflictDoUpdate({ target: t.memories.id, set: row })
        .run();
      this.events.append({
        workspaceId: memory.workspaceId,
        threadId: memory.threadId,
        type: "memory.upserted",
        payload: memory,
        createdAt: memory.updatedAt,
      });
      return memory;
    });
  }

  deleteMemory(id: string): void {
    const memory = this.getMemory(id);
    if (!memory) throw new NotFoundError("memory", id);

    this.events.transaction(() => {
      this.db.delete(t.memoryLinks).where(eq(t.memoryLinks.sourceId, id)).run();
      this.db.delete(t.memoryLinks).where(eq(t.memoryLinks.targetId, id)).run();
      this.db.delete(t.memories).where(eq(t.memories.id, id)).run();
      this.events.append({
        workspaceId: memory.workspaceId,
        threadId: memory.threadId,
        type: "memory.deleted",
        payload: { id, workspaceId: memory.workspaceId },
      });
    });
  }

  /** Add a typed edge to the memory graph; returns the updated source node. */
  linkMemories(
    sourceId: string,
    link: { targetId: string; type: MemoryLinkType; note?: string; createdAt?: string },
  ): Memory {
    const source = this.getMemory(sourceId);
    if (!source) throw new NotFoundError("memory", sourceId);
    if (!this.getMemory(link.targetId)) throw new NotFoundError("memory", link.targetId);

    const row = {
      sourceId,
      targetId: link.targetId,
      type: link.type,
      note: link.note ?? "",
      workspaceId: source.workspaceId,
      createdAt: link.createdAt ?? now(),
    };

    return this.events.transaction(() => {
      this.db
        .insert(t.memoryLinks)
        .values(row)
        .onConflictDoUpdate({
          target: [t.memoryLinks.sourceId, t.memoryLinks.targetId, t.memoryLinks.type],
          set: { note: row.note },
        })
        .run();
      this.events.append({
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        type: "memory.linked",
        payload: row,
        createdAt: row.createdAt,
      });
      return this.getMemory(sourceId) as Memory;
    });
  }

  unlinkMemories(sourceId: string, targetId: string, type: MemoryLinkType): Memory {
    const source = this.getMemory(sourceId);
    if (!source) throw new NotFoundError("memory", sourceId);

    return this.events.transaction(() => {
      this.db
        .delete(t.memoryLinks)
        .where(
          and(
            eq(t.memoryLinks.sourceId, sourceId),
            eq(t.memoryLinks.targetId, targetId),
            eq(t.memoryLinks.type, type),
          ),
        )
        .run();
      this.events.append({
        workspaceId: source.workspaceId,
        threadId: source.threadId,
        type: "memory.unlinked",
        payload: { sourceId, targetId, type },
      });
      return this.getMemory(sourceId) as Memory;
    });
  }

  // -------------------------------------------------------------- settings

  getSettings(): AppSettings {
    const row = this.db.select().from(t.settings).where(eq(t.settings.key, SETTINGS_KEY)).get();
    if (!row) return DEFAULT_APP_SETTINGS;
    const parsed = AppSettingsSchema.safeParse(row.value);
    return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS;
  }

  putSettings(patch: Partial<AppSettings>): AppSettings {
    const next = AppSettingsSchema.parse({ ...this.getSettings(), ...stripUndefined(patch) });
    const at = now();
    const workspaceId = this.listWorkspaces()[0]?.id;

    return this.events.transaction(() => {
      this.db
        .insert(t.settings)
        .values({ key: SETTINGS_KEY, value: next, updatedAt: at })
        .onConflictDoUpdate({ target: t.settings.key, set: { value: next, updatedAt: at } })
        .run();
      // Settings are machine-wide; the event is only logged when there is a
      // workspace to hang it off, since `events.workspaceId` is NOT NULL.
      if (workspaceId) {
        this.events.append({
          workspaceId,
          type: "settings.updated",
          payload: next,
          createdAt: at,
        });
      }
      return next;
    });
  }

  // ----------------------------------------------------------------- misc

  /** Raw event log for a thread (`GET /api/events?threadId=`). */
  readThreadEvents(threadId: string, afterSeq?: number): NexestraEvent[] {
    return this.events.readThread(threadId, afterSeq);
  }

  private touchThread(threadId: string, at: string): void {
    this.db
      .update(t.threads)
      .set({ lastActivityAt: at, updatedAt: at })
      .where(eq(t.threads.id, threadId))
      .run();
  }

  /** A task always belongs to a plan; create an empty one if the thread has none. */
  private ensurePlan(thread: Thread): Plan {
    const existing = this.getPlan(thread.id);
    if (existing) return existing;
    const spec = this.getSpec(thread.id) ?? this.upsertSpec(thread.id, { goal: thread.title });
    return this.upsertPlan(thread.id, { specId: spec.id, summary: "Ad-hoc plan" });
  }
}

/** Open the database and return the store. */
export function createStore(options: CreateStoreOptions = {}): NexestraStore {
  const { db, sqlite, file } = openDatabase(options);
  const dataDir = options.dataDir ?? dataDirectory(nexestraHome());
  return new NexestraStore(db, sqlite, file, dataDir);
}

/** `nexestra` → `NEX`; used when the UI does not supply a rail label. */
function shortLabelFor(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 2) || "WS").toUpperCase();
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
