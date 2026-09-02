/**
 * Realistic sample data. From M1 this is no longer served directly: it is what
 * `seedMock()` writes into the store on a fresh install, and what the schema
 * tests parse.
 *
 * Everything here is validated against the domain schemas at module load, so a
 * drift between the schemas and the fixtures fails loudly instead of silently
 * rendering nonsense.
 */
import { z } from "zod";
import { FileContentSchema, FileNodeSchema } from "../api.js";
import { ApprovalSchema } from "../domain/approval.js";
import { ArtifactSchema } from "../domain/artifact.js";
import { MemorySchema } from "../domain/memory.js";
import { MessageSchema } from "../domain/message.js";
import { PlanSchema } from "../domain/plan.js";
import { RunEventSchema, RunSchema } from "../domain/run.js";
import { SpecSchema } from "../domain/spec.js";
import { TaskSchema } from "../domain/task.js";
import { ThreadSchema } from "../domain/thread.js";
import { WorkspaceSchema } from "../domain/workspace.js";
import { HarnessInfoSchema } from "../harness.js";

const WS = "ws_nexestra";
const TH_APP = "th_agent_app";
const TH_RESEARCH = "th_research_workflow";
const PLAN_1 = "plan_agent_app_v2";
const SPEC_1 = "spec_agent_app_v3";

const t = (iso: string) => iso;
const base = (id: string, createdAt: string, updatedAt: string = createdAt) => ({
  id,
  workspaceId: WS,
  createdAt: t(createdAt),
  updatedAt: t(updatedAt),
});

// ---------------------------------------------------------------- workspaces

export const mockWorkspaces = z.array(WorkspaceSchema).parse([
  {
    id: WS,
    name: "nexestra",
    rootPath: "/Users/dev/Works/Nexestra",
    shortLabel: "NX",
    defaultBranch: "main",
    settings: {
      defaultHarness: "codex",
      defaultModel: "gpt-5.1-codex",
      defaultReasoning: "high",
      defaultSandbox: "workspace-write",
      concurrency: 2,
      budgetUSD: 25,
      autoMerge: false,
    },
    createdAt: "2026-08-24T08:12:00.000Z",
    updatedAt: "2026-09-01T16:40:00.000Z",
  },
]);

// ------------------------------------------------------------------- threads

export const mockThreads = z.array(ThreadSchema).parse([
  {
    ...base(TH_APP, "2026-08-28T09:02:00.000Z", "2026-09-01T16:40:00.000Z"),
    title: "Build agent app",
    phase: "executing",
    summary: "Harness abstraction + two adapters, driven by the orchestrator loop.",
    specId: SPEC_1,
    planId: PLAN_1,
    budgetUSD: 25,
    costUSD: 6.42,
    lastActivityAt: "2026-09-01T16:40:00.000Z",
  },
  {
    ...base(TH_RESEARCH, "2026-08-30T11:20:00.000Z", "2026-09-01T09:15:00.000Z"),
    title: "Research workflow",
    phase: "clarifying",
    summary: "Compare ACP against a bespoke adapter before committing to a third harness.",
    budgetUSD: 10,
    costUSD: 0.87,
    lastActivityAt: "2026-09-01T09:15:00.000Z",
  },
]);

// ---------------------------------------------------------------------- spec

export const mockSpecs = z.array(SpecSchema).parse([
  {
    ...base(SPEC_1, "2026-08-28T09:40:00.000Z", "2026-08-29T10:05:00.000Z"),
    threadId: TH_APP,
    version: 3,
    goal: "Drive Codex and OpenCode through one HarnessAdapter contract, streaming normalised events into the UI.",
    scope: {
      in: [
        "HarnessAdapter interface + normalised event union",
        "Codex adapter over `codex exec --json`",
        "OpenCode adapter over `opencode serve` + SSE",
        "git worktree isolation per task",
      ],
      out: [
        "ACP adapter (deferred until a third harness is needed)",
        "Remote / multi-user execution",
        "Automatic merge without approval",
      ],
    },
    constraints: [
      "Server binds 127.0.0.1 only; no auth in v1.",
      "Adapters must ignore unknown harness events instead of crashing.",
      "No direct file writes from Master; all edits go through a harness.",
    ],
    expectedOutcome:
      "A task dispatched from the board runs in its own worktree, streams events into the Editor surface, and lands a verified diff.",
    acceptanceCriteria: [
      {
        id: "ac_contract",
        text: "`HarnessAdapter` is implemented by both adapters and typechecks against the shared contract.",
        verification: { kind: "command", command: "pnpm typecheck", expectExitCode: 0 },
        satisfied: true,
        evidenceArtifactId: "art_typecheck_log",
      },
      {
        id: "ac_codex_parse",
        text: "Codex JSONL fixtures parse into HarnessEvent without dropping tool calls.",
        verification: {
          kind: "test",
          command: "pnpm vitest run",
          testPath: "packages/adapters/codex/src/parse.test.ts",
        },
        satisfied: true,
        evidenceArtifactId: "art_codex_tests",
      },
      {
        id: "ac_opencode_stream",
        text: "OpenCode SSE session streams assistant text and permission requests end to end.",
        verification: {
          kind: "test",
          command: "pnpm vitest run",
          testPath: "packages/adapters/opencode/src/stream.test.ts",
        },
        satisfied: false,
      },
      {
        id: "ac_worktree",
        text: "Two tasks run in parallel worktrees without touching each other's files.",
        verification: {
          kind: "manual_review",
          instructions:
            "Dispatch two tasks at once, confirm each diff only contains files from its own task.",
        },
        satisfied: false,
      },
    ],
    openQuestions: [],
    decisions: [
      {
        id: "dec_exec_json",
        text: "Use `codex exec --json` for v1 instead of `codex app-server`.",
        rationale: "Simpler and stable; app-server only needed once mid-run steering is required.",
        decidedAt: "2026-08-28T14:10:00.000Z",
      },
      {
        id: "dec_worktree",
        text: "One git worktree per task under `<repo>/.nexestra/worktrees/<taskId>`.",
        rationale: "Parallel harnesses cannot collide and each task has a clean diff.",
        decidedAt: "2026-08-29T09:55:00.000Z",
      },
    ],
    frozen: true,
  },
]);

// ---------------------------------------------------------------------- plan

export const mockPlans = z.array(PlanSchema).parse([
  {
    ...base(PLAN_1, "2026-08-29T10:20:00.000Z", "2026-09-01T13:02:00.000Z"),
    threadId: TH_APP,
    specId: SPEC_1,
    version: 2,
    summary: "Contract first, then the two adapters in parallel, then the dispatch loop.",
    taskIds: [
      "task_contract",
      "task_codex",
      "task_opencode",
      "task_worktree",
      "task_loop",
      "task_fixtures",
    ],
    edges: [
      { from: "task_contract", to: "task_codex" },
      { from: "task_contract", to: "task_opencode" },
      { from: "task_contract", to: "task_worktree" },
      { from: "task_codex", to: "task_loop" },
      { from: "task_opencode", to: "task_loop" },
      { from: "task_worktree", to: "task_loop" },
      { from: "task_codex", to: "task_fixtures" },
      { from: "task_opencode", to: "task_fixtures" },
    ],
  },
]);

// --------------------------------------------------------------------- tasks

export const mockTasks = z.array(TaskSchema).parse([
  {
    ...base("task_contract", "2026-08-29T10:20:00.000Z", "2026-08-29T15:44:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "Define HarnessAdapter contract",
    description:
      "Write the shared interface plus the normalised HarnessEvent union in packages/core and make both adapters compile against it.",
    dependsOn: [],
    assignedHarness: "codex",
    harnessConfig: {
      model: "gpt-5.1-codex",
      reasoning: "high",
      sandbox: "workspace-write",
      tools: ["shell", "apply_patch"],
      branch: "nx/task-contract",
      worktreePath: ".nexestra/worktrees/task_contract",
    },
    status: "done",
    attempts: 1,
    acceptanceCriteriaIds: ["ac_contract"],
    costUSD: 0.84,
    order: 0,
  },
  {
    ...base("task_codex", "2026-08-29T10:20:00.000Z", "2026-08-31T18:12:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "Codex adapter: exec --json",
    description:
      "Spawn `codex exec --json -C <worktree>`, parse JSONL into HarnessEvent, surface usage and exit code.",
    dependsOn: ["task_contract"],
    assignedHarness: "codex",
    harnessConfig: {
      model: "gpt-5.1-codex",
      reasoning: "high",
      sandbox: "workspace-write",
      tools: ["shell", "apply_patch"],
      branch: "nx/task-codex",
      worktreePath: ".nexestra/worktrees/task_codex",
    },
    status: "done",
    attempts: 2,
    acceptanceCriteriaIds: ["ac_codex_parse"],
    costUSD: 2.31,
    order: 1,
  },
  {
    ...base("task_opencode", "2026-08-29T10:20:00.000Z", "2026-09-01T16:40:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "OpenCode adapter: serve + SSE",
    description:
      "Manage one `opencode serve --port 0` per workspace, create sessions, subscribe to SSE, answer permission prompts.",
    dependsOn: ["task_contract"],
    assignedHarness: "opencode",
    harnessConfig: {
      model: "anthropic/claude-opus-5",
      reasoning: "high",
      sandbox: "workspace-write",
      tools: ["bash", "edit", "read"],
      branch: "nx/task-opencode",
      worktreePath: ".nexestra/worktrees/task_opencode",
    },
    status: "running",
    attempts: 1,
    acceptanceCriteriaIds: ["ac_opencode_stream"],
    costUSD: 1.92,
    order: 0,
  },
  {
    ...base("task_worktree", "2026-08-29T10:20:00.000Z", "2026-09-01T15:58:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "Worktree manager",
    description:
      "Create, reuse and tear down `git worktree` directories per task; merge back to the target branch behind an approval.",
    dependsOn: ["task_contract"],
    assignedHarness: "codex",
    harnessConfig: {
      model: "gpt-5.1-codex",
      reasoning: "medium",
      sandbox: "workspace-write",
      tools: ["shell"],
      branch: "nx/task-worktree",
      worktreePath: ".nexestra/worktrees/task_worktree",
    },
    status: "verifying",
    attempts: 1,
    acceptanceCriteriaIds: ["ac_worktree"],
    costUSD: 1.35,
    order: 1,
  },
  {
    ...base("task_loop", "2026-08-29T10:20:00.000Z", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "Orchestrator dispatch loop",
    description:
      "Pick ready tasks (all dependsOn done), respect concurrency, stream run events into the projection and the WebSocket.",
    dependsOn: ["task_codex", "task_opencode", "task_worktree"],
    assignedHarness: "codex",
    harnessConfig: {
      model: "gpt-5.1-codex",
      reasoning: "high",
      sandbox: "workspace-write",
      tools: ["shell", "apply_patch"],
    },
    status: "todo",
    attempts: 0,
    acceptanceCriteriaIds: [],
    costUSD: 0,
    order: 0,
  },
  {
    ...base("task_fixtures", "2026-08-29T10:20:00.000Z", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    planId: PLAN_1,
    title: "Contract tests from recorded fixtures",
    description:
      "Record real JSONL/SSE output into fixtures/ and assert both adapters parse it without crashing on unknown events.",
    dependsOn: ["task_codex", "task_opencode"],
    assignedHarness: "opencode",
    harnessConfig: {
      model: "anthropic/claude-opus-5",
      reasoning: "medium",
      sandbox: "read-only",
      tools: ["read", "bash"],
    },
    status: "todo",
    attempts: 0,
    acceptanceCriteriaIds: ["ac_codex_parse", "ac_opencode_stream"],
    costUSD: 0,
    order: 1,
  },
]);

// ---------------------------------------------------------------------- runs

export const mockRuns = z.array(RunSchema).parse([
  {
    ...base("run_contract_1", "2026-08-29T10:25:00.000Z", "2026-08-29T15:44:00.000Z"),
    threadId: TH_APP,
    taskId: "task_contract",
    kind: "execute",
    harness: "codex",
    sessionRef: "codex/0193f0c1-4f8a",
    worktreePath: ".nexestra/worktrees/task_contract",
    status: "succeeded",
    exitCode: 0,
    usage: { inputTokens: 48_210, outputTokens: 6_140, cachedInputTokens: 31_000, costUSD: 0.84 },
    startedAt: "2026-08-29T10:25:00.000Z",
    endedAt: "2026-08-29T10:41:00.000Z",
  },
  {
    ...base("run_codex_1", "2026-08-30T09:02:00.000Z", "2026-08-30T09:38:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    kind: "execute",
    harness: "codex",
    sessionRef: "codex/0193f4aa-1b02",
    worktreePath: ".nexestra/worktrees/task_codex",
    status: "failed",
    exitCode: 1,
    usage: { inputTokens: 61_400, outputTokens: 9_300, cachedInputTokens: 40_100, costUSD: 1.12 },
    startedAt: "2026-08-30T09:02:00.000Z",
    endedAt: "2026-08-30T09:38:00.000Z",
  },
  {
    ...base("run_codex_2", "2026-08-31T17:20:00.000Z", "2026-08-31T18:12:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    kind: "execute",
    harness: "codex",
    sessionRef: "codex/0193fb31-77de",
    worktreePath: ".nexestra/worktrees/task_codex",
    status: "succeeded",
    exitCode: 0,
    usage: { inputTokens: 55_900, outputTokens: 8_020, cachedInputTokens: 38_400, costUSD: 0.96 },
    startedAt: "2026-08-31T17:20:00.000Z",
    endedAt: "2026-08-31T18:12:00.000Z",
  },
  {
    ...base("run_codex_review", "2026-08-31T18:14:00.000Z", "2026-08-31T18:26:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    kind: "review",
    harness: "opencode",
    sessionRef: "opencode/ses_8f31d0",
    worktreePath: ".nexestra/worktrees/task_codex",
    status: "succeeded",
    exitCode: 0,
    usage: { inputTokens: 22_100, outputTokens: 2_800, cachedInputTokens: 0, costUSD: 0.23 },
    startedAt: "2026-08-31T18:14:00.000Z",
    endedAt: "2026-08-31T18:26:00.000Z",
  },
  {
    ...base("run_opencode_1", "2026-09-01T16:02:00.000Z", "2026-09-01T16:40:00.000Z"),
    threadId: TH_APP,
    taskId: "task_opencode",
    kind: "execute",
    harness: "opencode",
    sessionRef: "opencode/ses_a41c9b",
    worktreePath: ".nexestra/worktrees/task_opencode",
    status: "running",
    usage: { inputTokens: 74_500, outputTokens: 11_240, cachedInputTokens: 51_000, costUSD: 1.92 },
    startedAt: "2026-09-01T16:02:00.000Z",
  },
]);

export const mockRunEvents = z.array(RunEventSchema).parse([
  {
    id: "ev_1",
    workspaceId: WS,
    threadId: TH_APP,
    runId: "run_opencode_1",
    seq: 0,
    type: "started",
    payload: { type: "started", sessionRef: "opencode/ses_a41c9b" },
    createdAt: "2026-09-01T16:02:00.000Z",
  },
  {
    id: "ev_2",
    workspaceId: WS,
    threadId: TH_APP,
    runId: "run_opencode_1",
    seq: 1,
    type: "assistant_text",
    payload: {
      type: "assistant_text",
      text: "Reading the adapter contract before touching the SSE client.",
    },
    createdAt: "2026-09-01T16:02:40.000Z",
  },
  {
    id: "ev_3",
    workspaceId: WS,
    threadId: TH_APP,
    runId: "run_opencode_1",
    seq: 2,
    type: "command",
    payload: { type: "command", cmd: "pnpm vitest run packages/adapters/opencode", exitCode: 0 },
    createdAt: "2026-09-01T16:21:00.000Z",
  },
  {
    id: "ev_4",
    workspaceId: WS,
    threadId: TH_APP,
    runId: "run_opencode_1",
    seq: 3,
    type: "file_changed",
    payload: {
      type: "file_changed",
      path: "packages/adapters/opencode/src/stream.ts",
      kind: "add",
    },
    createdAt: "2026-09-01T16:29:00.000Z",
  },
  {
    id: "ev_5",
    workspaceId: WS,
    threadId: TH_APP,
    runId: "run_opencode_1",
    seq: 4,
    type: "usage",
    payload: { type: "usage", inputTokens: 74_500, outputTokens: 11_240, costUSD: 1.92 },
    createdAt: "2026-09-01T16:40:00.000Z",
  },
]);

// ----------------------------------------------------------------- artifacts

export const mockArtifacts = z.array(ArtifactSchema).parse([
  {
    ...base("art_typecheck_log", "2026-08-29T15:44:00.000Z"),
    threadId: TH_APP,
    taskId: "task_contract",
    runId: "run_contract_1",
    kind: "log",
    title: "pnpm typecheck — clean",
    path: "artifacts/task_contract/typecheck.log",
    mimeType: "text/plain",
    sizeBytes: 1_204,
    preview: "> tsc -b\n\nDone in 4.1s. 0 errors.",
  },
  {
    ...base("art_codex_diff", "2026-08-31T18:12:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    runId: "run_codex_2",
    kind: "diff",
    title: "packages/adapters/codex — 4 files changed",
    path: "artifacts/task_codex/changes.diff",
    mimeType: "text/x-diff",
    sizeBytes: 8_910,
    preview: [
      "+++ packages/adapters/codex/src/parse.ts",
      "@@",
      "+export function parseCodexLine(line: string): HarnessEvent | null {",
      "+  const raw = safeJsonParse(line);",
      "+  if (!raw) return null;",
      "+  switch (raw.type) {",
      "+    case 'item.completed': return mapItem(raw.item);",
    ].join("\n"),
  },
  {
    ...base("art_codex_tests", "2026-08-31T18:13:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    runId: "run_codex_2",
    kind: "test_report",
    title: "vitest — 18 passed",
    path: "artifacts/task_codex/vitest.json",
    mimeType: "application/json",
    sizeBytes: 4_320,
    preview: "PASS packages/adapters/codex/src/parse.test.ts (18 tests) 412ms",
  },
  {
    ...base("art_opencode_log", "2026-09-01T16:40:00.000Z"),
    threadId: TH_APP,
    taskId: "task_opencode",
    runId: "run_opencode_1",
    kind: "log",
    title: "opencode session log (streaming)",
    path: "artifacts/task_opencode/session.log",
    mimeType: "text/plain",
    sizeBytes: 22_140,
    preview: 'event: message.part.updated\ndata: {"type":"text","text":"Wiring SSE..."}',
  },
]);

// ----------------------------------------------------------------- approvals

export const mockApprovals = z.array(ApprovalSchema).parse([
  {
    ...base("appr_sandbox", "2026-09-01T15:58:00.000Z"),
    threadId: TH_APP,
    taskId: "task_worktree",
    runId: undefined,
    kind: "sandbox_escalation",
    title: "Worktree manager needs danger-full-access",
    description:
      "`git worktree prune` touches paths outside the workspace root. Approve to let this run escalate for 1 command.",
    risk: "high",
    status: "pending",
    requestedAt: "2026-09-01T15:58:00.000Z",
  },
  {
    ...base("appr_merge", "2026-08-31T18:30:00.000Z"),
    threadId: TH_APP,
    taskId: "task_codex",
    kind: "merge",
    title: "Merge nx/task-codex into main",
    description:
      "4 files changed, 18 tests passing, cross-review by OpenCode returned no blockers.",
    risk: "low",
    status: "pending",
    requestedAt: "2026-08-31T18:30:00.000Z",
  },
]);

// ------------------------------------------------------------------ messages

export const mockMessages = z.array(MessageSchema).parse([
  {
    ...base("msg_1", "2026-08-28T09:02:00.000Z"),
    threadId: TH_APP,
    role: "user",
    content:
      "I want Nexestra to drive both Codex and OpenCode from the same UI. Start with the adapter layer.",
  },
  {
    ...base("msg_2", "2026-08-28T09:03:10.000Z"),
    threadId: TH_APP,
    role: "master",
    content: [
      "Before I plan anything I need five things pinned down: goal, scope, constraints,",
      "expected outcome and how we know it is finished.",
      "",
      "1. Should the first milestone cover both harnesses, or Codex only?",
      "2. Do runs need to be steerable mid-flight, or is fire-and-forget enough for v1?",
      "3. Is `danger-full-access` ever allowed without asking you first?",
    ].join("\n"),
  },
  {
    ...base("msg_3", "2026-08-28T09:11:00.000Z"),
    threadId: TH_APP,
    role: "user",
    content:
      "Both harnesses. Fire-and-forget is fine for v1. Never escalate the sandbox without asking me.",
  },
  {
    ...base("msg_4", "2026-08-28T14:12:00.000Z"),
    threadId: TH_APP,
    role: "master",
    content:
      "Spec v3 is frozen: one HarnessAdapter contract, two adapters, worktree isolation, 4 acceptance criteria. Planning next.",
    references: [
      { kind: "thread", id: TH_APP, label: "#spec/v3" },
      { kind: "memory", id: "mem_decision_exec_json", label: "#memory/exec-json" },
    ],
    toolCalls: [
      {
        callId: "call_update_spec_3",
        name: "update_spec",
        input: { version: 3, frozen: true },
        output: { ok: true, acceptanceCriteria: 4 },
        ok: true,
      },
    ],
  },
  {
    ...base("msg_5", "2026-08-29T10:21:00.000Z"),
    threadId: TH_APP,
    role: "master",
    content: "Plan v2 proposed: 6 tasks, 8 dependency edges, no cycles.",
    attachments: [
      {
        kind: "plan_preview",
        planId: PLAN_1,
        title: "Plan v2 — 6 tasks",
        taskTitles: [
          "Define HarnessAdapter contract",
          "Codex adapter: exec --json",
          "OpenCode adapter: serve + SSE",
          "Worktree manager",
          "Orchestrator dispatch loop",
          "Contract tests from recorded fixtures",
        ],
      },
    ],
  },
  {
    ...base("msg_6", "2026-08-31T18:13:00.000Z"),
    threadId: TH_APP,
    role: "master",
    content:
      "Codex adapter passed on attempt 2. Cross-review ran on OpenCode and found no blocking issues.",
    references: [{ kind: "task", id: "task_codex", label: "#task/codex-adapter" }],
    attachments: [
      {
        kind: "test_report",
        title: "vitest — packages/adapters/codex",
        passed: 18,
        failed: 0,
        output: "PASS packages/adapters/codex/src/parse.test.ts (18 tests) 412ms",
      },
      {
        kind: "diff",
        title: "packages/adapters/codex/src/parse.ts",
        path: "packages/adapters/codex/src/parse.ts",
        patch: [
          "@@ -1,6 +1,24 @@",
          '+import type { HarnessEvent } from "@nexestra/core";',
          "+",
          "+export function parseCodexLine(line: string): HarnessEvent | null {",
          "+  const raw = safeJsonParse(line);",
          "+  if (!raw) return null;                 // unknown line -> ignore, never throw",
          "+  switch (raw.type) {",
          '+    case "session.created":',
          '+      return { type: "started", sessionRef: raw.session_id };',
          "+    default:",
          "+      return null;",
          "+  }",
          "+}",
        ].join("\n"),
      },
    ],
  },
  {
    ...base("msg_7", "2026-09-01T15:58:00.000Z"),
    threadId: TH_APP,
    role: "system",
    content:
      "Approval required — task_worktree requested danger-full-access. Run is paused until you decide.",
    references: [{ kind: "task", id: "task_worktree", label: "#task/worktree-manager" }],
  },
  {
    ...base("msg_r1", "2026-08-30T11:20:00.000Z"),
    threadId: TH_RESEARCH,
    role: "user",
    content: "Is ACP worth adopting as a third adapter, or should we keep writing bespoke ones?",
  },
  {
    ...base("msg_r2", "2026-08-30T11:21:30.000Z"),
    threadId: TH_RESEARCH,
    role: "master",
    content: [
      "Two questions before I look:",
      "",
      "1. Which harnesses would you actually plug in through ACP in the next 3 months?",
      "2. Is a slower event stream acceptable in exchange for not writing adapter code?",
    ].join("\n"),
  },
]);

// ------------------------------------------------------------------ memories

export const mockMemories = z.array(MemorySchema).parse([
  {
    ...base("mem_goal", "2026-08-28T09:05:00.000Z"),
    threadId: TH_APP,
    type: "goal",
    title: "Drive many harnesses from one control center",
    content:
      "Turn a vague request into a frozen spec, then supervise Codex and OpenCode until the acceptance criteria have evidence.",
    links: [
      { type: "relates_to", targetId: "mem_req_normalised_events", note: "" },
      { type: "relates_to", targetId: "mem_arch_worktree", note: "" },
    ],
    source: { kind: "message", id: "msg_1", label: "Chat — intake" },
    tags: ["north-star"],
  },
  {
    ...base("mem_req_normalised_events", "2026-08-28T10:02:00.000Z"),
    threadId: TH_APP,
    type: "requirement",
    title: "One normalised event schema for every harness",
    content:
      "Every adapter maps its native output onto HarnessEvent. Unknown events are logged and dropped, never thrown.",
    links: [
      { type: "derives_from", targetId: "mem_goal", note: "" },
      { type: "implements", targetId: "mem_task_contract", note: "" },
    ],
    source: { kind: "spec", id: SPEC_1, label: "Spec v3 — scope.in" },
    tags: ["contract"],
  },
  {
    ...base("mem_req_no_direct_writes", "2026-08-28T10:06:00.000Z"),
    threadId: TH_APP,
    type: "requirement",
    title: "Master never writes files directly",
    content: "All code changes go through a harness inside a worktree, so every edit has a diff.",
    links: [{ type: "derives_from", targetId: "mem_goal", note: "" }],
    source: { kind: "spec", id: SPEC_1, label: "Spec v3 — constraints" },
    tags: ["safety"],
  },
  {
    ...base("mem_decision_exec_json", "2026-08-28T14:10:00.000Z"),
    threadId: TH_APP,
    type: "decision",
    title: "Codex v1 uses `codex exec --json`",
    content:
      "JSONL on stdout is stable and simple. Move to `codex app-server` only when mid-run steering is needed.",
    links: [
      { type: "derives_from", targetId: "mem_research_codex_modes", note: "" },
      { type: "implements", targetId: "mem_task_codex", note: "" },
    ],
    source: { kind: "message", id: "msg_4", label: "Chat — spec frozen" },
    tags: ["adapter", "codex"],
  },
  {
    ...base("mem_research_codex_modes", "2026-08-28T13:40:00.000Z"),
    threadId: TH_APP,
    type: "research",
    title: "Codex CLI: exec vs app-server",
    content:
      "`exec --json` supports -C, -m, -s, --output-schema and --ephemeral. `app-server` speaks JSON-RPC and allows answering approvals mid-run.",
    links: [{ type: "relates_to", targetId: "mem_research_opencode_serve", note: "" }],
    source: { kind: "run", id: "run_contract_1", label: "codex --help capture" },
    tags: ["codex", "0.148.0"],
  },
  {
    ...base("mem_research_opencode_serve", "2026-08-28T13:55:00.000Z"),
    threadId: TH_APP,
    type: "research",
    title: "OpenCode server mode gives SSE + permission replies",
    content:
      "`opencode serve --port 0` plus @opencode-ai/sdk allows parallel sessions and answering permission prompts over HTTP.",
    links: [{ type: "implements", targetId: "mem_task_opencode", note: "" }],
    source: { kind: "run", id: "run_contract_1", label: "opencode serve capture" },
    tags: ["opencode", "1.18.25"],
  },
  {
    ...base("mem_arch_worktree", "2026-08-29T09:55:00.000Z"),
    threadId: TH_APP,
    type: "architecture",
    title: "One git worktree per task",
    content:
      "`<repo>/.nexestra/worktrees/<taskId>` isolates parallel harness runs and produces a clean per-task diff.",
    links: [
      { type: "derives_from", targetId: "mem_req_no_direct_writes", note: "" },
      { type: "implements", targetId: "mem_task_worktree", note: "" },
    ],
    source: { kind: "spec", id: SPEC_1, label: "Spec v3 — decisions" },
    tags: ["isolation"],
  },
  {
    ...base("mem_arch_event_sourced", "2026-08-29T10:10:00.000Z"),
    threadId: TH_APP,
    type: "architecture",
    title: "Event-sourced store, projections for the UI",
    content:
      "Append-only events per run; projections are rebuildable. Same mechanism powers replay, audit and the realtime WebSocket.",
    links: [{ type: "derives_from", targetId: "mem_req_normalised_events", note: "" }],
    source: { kind: "user", id: "user_local", label: "PLAN.md §3" },
    tags: ["storage"],
  },
  {
    ...base("mem_task_contract", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    type: "task",
    title: "Task — Define HarnessAdapter contract",
    content: "Shipped in packages/core. Both adapters compile against it.",
    links: [{ type: "verified_by", targetId: "mem_artifact_typecheck", note: "" }],
    source: { kind: "task", id: "task_contract", label: "#task/contract" },
    tags: ["done"],
  },
  {
    ...base("mem_task_codex", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    type: "task",
    title: "Task — Codex adapter",
    content:
      "Attempt 1 failed on unknown JSONL items; attempt 2 passed after the parser stopped throwing.",
    links: [
      { type: "verified_by", targetId: "mem_artifact_codex_tests", note: "" },
      { type: "derives_from", targetId: "mem_lesson_unknown_events", note: "" },
    ],
    source: { kind: "task", id: "task_codex", label: "#task/codex-adapter" },
    tags: ["done"],
  },
  {
    ...base("mem_task_opencode", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    type: "task",
    title: "Task — OpenCode adapter",
    content: "Running now. SSE stream lands assistant text; permission replies still to wire.",
    links: [
      { type: "blocks", targetId: "mem_task_loop", note: "orchestrator needs both adapters" },
    ],
    source: { kind: "task", id: "task_opencode", label: "#task/opencode-adapter" },
    tags: ["running"],
  },
  {
    ...base("mem_task_worktree", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    type: "task",
    title: "Task — Worktree manager",
    content: "Waiting on a sandbox escalation approval for `git worktree prune`.",
    links: [{ type: "blocks", targetId: "mem_task_loop", note: "" }],
    source: { kind: "task", id: "task_worktree", label: "#task/worktree-manager" },
    tags: ["blocked"],
  },
  {
    ...base("mem_task_loop", "2026-08-29T10:20:00.000Z"),
    threadId: TH_APP,
    type: "task",
    title: "Task — Orchestrator dispatch loop",
    content: "Not started; depends on the two adapters and the worktree manager.",
    links: [],
    source: { kind: "task", id: "task_loop", label: "#task/dispatch-loop" },
    tags: ["todo"],
  },
  {
    ...base("mem_artifact_typecheck", "2026-08-29T15:44:00.000Z"),
    threadId: TH_APP,
    type: "artifact",
    title: "Evidence — pnpm typecheck clean",
    content: "0 errors across 9 packages.",
    links: [],
    source: { kind: "artifact", id: "art_typecheck_log", label: "typecheck.log" },
    tags: ["evidence"],
  },
  {
    ...base("mem_artifact_codex_tests", "2026-08-31T18:13:00.000Z"),
    threadId: TH_APP,
    type: "artifact",
    title: "Evidence — 18 codex adapter tests passing",
    content: "PASS packages/adapters/codex/src/parse.test.ts (18 tests) 412ms",
    links: [],
    source: { kind: "artifact", id: "art_codex_tests", label: "vitest.json" },
    tags: ["evidence"],
  },
  {
    ...base("mem_lesson_unknown_events", "2026-08-30T09:40:00.000Z"),
    threadId: TH_APP,
    type: "lesson",
    title: "Never throw on an unknown harness event",
    content:
      "Codex 0.148 emits item types the parser had not seen. Throwing killed the whole run; log and skip instead.",
    links: [{ type: "derives_from", targetId: "mem_task_codex", note: "" }],
    source: { kind: "run", id: "run_codex_1", label: "Failed run — attempt 1" },
    tags: ["retro"],
    authoredBy: "master",
  },
]);

// ------------------------------------------------------------- editor mocks

export const mockFileTree = z.array(FileNodeSchema).parse([
  { path: "src", name: "src", kind: "dir", children: ["src/master", "src/adapters", "src/ui"] },
  {
    path: "src/master",
    name: "master",
    kind: "dir",
    children: ["src/master/loop.ts", "src/master/prompts.ts"],
  },
  { path: "src/master/loop.ts", name: "loop.ts", kind: "file", status: "unchanged" },
  { path: "src/master/prompts.ts", name: "prompts.ts", kind: "file", status: "unchanged" },
  {
    path: "src/adapters",
    name: "adapters",
    kind: "dir",
    children: ["src/adapters/codex.ts", "src/adapters/open.ts"],
  },
  { path: "src/adapters/codex.ts", name: "codex.ts", kind: "file", status: "modified" },
  { path: "src/adapters/open.ts", name: "open.ts", kind: "file", status: "added" },
  { path: "src/ui", name: "ui", kind: "dir", children: ["src/ui/shell.tsx"] },
  { path: "src/ui/shell.tsx", name: "shell.tsx", kind: "file", status: "unchanged" },
  { path: "tests", name: "tests", kind: "dir", children: ["tests/adapter"] },
  {
    path: "tests/adapter",
    name: "adapter",
    kind: "dir",
    children: ["tests/adapter/codex.test.ts"],
  },
  { path: "tests/adapter/codex.test.ts", name: "codex.test.ts", kind: "file", status: "modified" },
]);

const HARNESS_ADAPTER_SOURCE = `import type { HarnessEvent, HarnessInfo, PreparedRun, RunControl, RunSpec } from "@nexestra/core";

/**
 * Every coding harness Nexestra drives is normalised to this contract.
 * Adapters own the process lifecycle; the orchestrator owns the policy.
 */
export interface HarnessAdapter {
  readonly id: "codex" | "opencode" | "acp";

  /** Locate the binary, read its version, check that auth works. */
  discover(): Promise<HarnessInfo>;

  /** Build the command line, create the worktree, write instruction files. */
  prepare(spec: RunSpec): Promise<PreparedRun>;

  /** Spawn the harness and stream normalised events until it exits. */
  run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent>;

  /** pause | cancel | answer_permission | steer, applied to a live run. */
  control(runId: string, action: RunControl): Promise<void>;
}

export type RunSpecKind = RunSpec["kind"]; // "execute" | "review" | "verify"

/**
 * Unknown events are dropped, never thrown: harness output formats drift
 * between versions and one surprise item must not kill a 20 minute run.
 */
export function isKnownEvent(value: unknown): value is HarnessEvent {
  return typeof value === "object" && value !== null && "type" in value;
}
`;

const CODEX_TEST_SOURCE = `import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/parse.js";

describe("parseCodexLine", () => {
  it("maps session.created to started", () => {
    const event = parseCodexLine('{"type":"session.created","session_id":"abc"}');
    expect(event).toEqual({ type: "started", sessionRef: "abc" });
  });

  it("ignores unknown item types instead of throwing", () => {
    expect(parseCodexLine('{"type":"totally.new.thing"}')).toBeNull();
  });
});
`;

export const mockFileContents = z.array(FileContentSchema).parse([
  {
    path: "src/adapters/codex.ts",
    language: "typescript",
    content: HARNESS_ADAPTER_SOURCE,
  },
  {
    path: "src/adapters/open.ts",
    language: "typescript",
    content: HARNESS_ADAPTER_SOURCE,
  },
  {
    path: "tests/adapter/codex.test.ts",
    language: "typescript",
    content: CODEX_TEST_SOURCE,
  },
]);

/** Lines replayed into the xterm pane of the Editor surface. */
export const mockTerminalLines: readonly string[] = [
  "$ npm test",
  "> nexestra@0.0.0 test  (vitest run)",
  "",
  "PASS tests/adapter/codex.test.ts (18 tests) 412ms",
  "PASS tests/adapter/open.test.ts  (9 tests) 233ms",
  "",
  " Test Files  2 passed (2)      Tests  27 passed (27)",
  "   Duration  1.24s",
  "$ ",
];

// ------------------------------------------------------------ settings mocks

export const mockHarnesses = z.array(HarnessInfoSchema).parse([
  {
    id: "codex",
    available: true,
    binaryPath: "/opt/homebrew/bin/codex",
    version: "0.148.0",
    supportedVersionRange: ">=0.140 <0.150",
    models: ["gpt-5.1-codex", "gpt-5.1-codex-mini"],
    defaultModel: "gpt-5.1-codex",
    authOk: true,
    warnings: [],
    detectedAt: "2026-09-01T08:00:00.000Z",
  },
  {
    id: "opencode",
    available: true,
    binaryPath: "/opt/homebrew/bin/opencode",
    version: "1.18.25",
    supportedVersionRange: ">=1.18 <2",
    models: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-4-5"],
    defaultModel: "anthropic/claude-opus-5",
    authOk: true,
    warnings: [],
    detectedAt: "2026-09-01T08:00:00.000Z",
  },
  {
    id: "acp",
    available: false,
    models: [],
    authOk: false,
    warnings: ["Not implemented yet — planned after the first two adapters ship."],
  },
]);

/** Everything the web app needs for one workspace, in a single payload. */
export const mockBundle = {
  workspaces: mockWorkspaces,
  threads: mockThreads,
  specs: mockSpecs,
  plans: mockPlans,
  tasks: mockTasks,
  runs: mockRuns,
  runEvents: mockRunEvents,
  artifacts: mockArtifacts,
  approvals: mockApprovals,
  messages: mockMessages,
  memories: mockMemories,
  fileTree: mockFileTree,
  fileContents: mockFileContents,
  terminalLines: mockTerminalLines,
  harnesses: mockHarnesses,
} as const;
