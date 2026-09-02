/**
 * `FakeHost` — an in-memory `MasterHost`.
 *
 * Every call is recorded, so a test can assert on what the Master asked the
 * outside world to do; the workspace is a plain `path → content` map, so
 * `read_workspace` and `search_code` work without touching a real repo.
 *
 * Approvals default to `pending`, which is the interesting case (the turn
 * suspends and waits for the user). Set `autoApprove` to resolve them inline.
 */
import type { Memory } from "@nexestra/core";
import type {
  ApprovalRequestResult,
  DispatchTaskResult,
  MarkCriterionResult,
  MasterHost,
  ReadArtifactResult,
  ReadRunEventsResult,
  ReadWorkspaceResult,
  RunVerificationResult,
  SearchCodeResult,
  TaskDispatchDefaults,
  VerificationOutcome,
  WorkspaceEntry,
} from "./host.js";
import type { MasterPlanProposal } from "./plan.js";
import type {
  ControlRunInput,
  DispatchTaskInput,
  MarkCriterionInput,
  ReadArtifactInput,
  ReadRunEventsInput,
  ReadWorkspaceInput,
  RecordMemoryInput,
  RequestApprovalInput,
  RunVerificationInput,
  SearchCodeInput,
  SummarizeInput,
} from "./tools/schemas.js";

export interface FakeHostCall {
  readonly name: string;
  readonly input: unknown;
}

export interface FakeHostOptions {
  readonly workspaceId?: string;
  /** Virtual workspace: relative path → file content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Resolve approvals immediately instead of suspending the turn. */
  readonly autoApprove?: boolean | ((input: RequestApprovalInput) => "approved" | "rejected");
  readonly artifacts?: Readonly<Record<string, { kind: string; title: string; content: string }>>;
  readonly runEvents?: Readonly<
    Record<string, readonly { seq: number; type: string; payload: unknown }[]>
  >;
  /** Verification results keyed by criterion id. */
  readonly verification?: Readonly<Record<string, VerificationOutcome>>;
  readonly dispatchDefaults?: TaskDispatchDefaults;
}

export interface FakeHost extends MasterHost {
  readonly calls: readonly FakeHostCall[];
  readonly memories: readonly Memory[];
  readonly approvals: readonly { id: string; request: RequestApprovalInput }[];
  readonly plans: readonly MasterPlanProposal[];
  readonly phaseChanges: readonly { from: string; to: string; reason: string }[];
  callsTo(name: string): readonly FakeHostCall[];
}

const DEFAULT_DISPATCH_DEFAULTS: TaskDispatchDefaults = {
  harness: "codex",
  reasoning: "medium",
  sandbox: "workspace-write",
};

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const workspaceId = options.workspaceId ?? "ws_fake";
  const files = options.files ?? {};
  const calls: FakeHostCall[] = [];
  const memories: Memory[] = [];
  const approvals: { id: string; request: RequestApprovalInput }[] = [];
  const plans: MasterPlanProposal[] = [];
  const phaseChanges: { from: string; to: string; reason: string }[] = [];
  let counter = 0;
  const nextId = (prefix: string) => {
    counter += 1;
    return `${prefix}_${counter.toString(36)}`;
  };

  const record = (name: string, input: unknown) => {
    calls.push({ name, input });
  };

  function entriesFor(prefix: string): WorkspaceEntry[] {
    const directories = new Set<string>();
    const entries: WorkspaceEntry[] = [];
    for (const [filePath, content] of Object.entries(files)) {
      if (prefix !== "." && !filePath.startsWith(`${prefix}/`)) continue;
      const segments = filePath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
      entries.push({ path: filePath, kind: "file", size: content.length });
    }
    for (const directory of directories) entries.push({ path: directory, kind: "dir" });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return entries;
  }

  return {
    get calls() {
      return calls;
    },
    get memories() {
      return memories;
    },
    get approvals() {
      return approvals;
    },
    get plans() {
      return plans;
    },
    get phaseChanges() {
      return phaseChanges;
    },
    callsTo(name) {
      return calls.filter((call) => call.name === name);
    },

    async readWorkspace(input: ReadWorkspaceInput): Promise<ReadWorkspaceResult> {
      record("readWorkspace", input);
      const prefix = input.path ?? ".";
      const manifests =
        input.includeManifests === false
          ? []
          : Object.entries(files)
              .filter(([filePath]) => /(^|\/)(README\.md|package\.json|AGENTS\.md)$/.test(filePath))
              .map(([filePath, content]) => ({ path: filePath, content, truncated: false }));
      return {
        root: `/fake/${workspaceId}`,
        entries: entriesFor(prefix),
        manifests,
        truncated: false,
      };
    },

    async searchCode(input: SearchCodeInput): Promise<SearchCodeResult> {
      record("searchCode", input);
      const matcher = input.regex ? new RegExp(input.query) : null;
      const matches = [];
      for (const [filePath, content] of Object.entries(files)) {
        if (input.path && !filePath.startsWith(input.path)) continue;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (matcher ? matcher.test(line) : line.includes(input.query)) {
            matches.push({ path: filePath, line: index + 1, text: line });
          }
        }
      }
      const limit = input.maxResults ?? 60;
      return {
        matches: matches.slice(0, limit),
        truncated: matches.length > limit,
        engine: "walk",
      };
    },

    async recordMemory(input: RecordMemoryInput): Promise<Memory> {
      record("recordMemory", input);
      const now = new Date(0).toISOString();
      const memory: Memory = {
        id: nextId("mem"),
        workspaceId,
        createdAt: now,
        updatedAt: now,
        type: input.type,
        title: input.title,
        content: input.content,
        links: (input.links ?? []).map((link) => ({
          type: link.type,
          targetId: link.targetId,
          note: link.note ?? "",
        })),
        tags: input.tags ?? [],
        authoredBy: "master",
      };
      memories.push(memory);
      return memory;
    },

    async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestResult> {
      record("requestApproval", input);
      const id = nextId("apr");
      approvals.push({ id, request: input });
      const auto = options.autoApprove;
      if (!auto) return { approvalId: id, status: "pending" };
      const status = typeof auto === "function" ? auto(input) : "approved";
      return { approvalId: id, status };
    },

    async dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult> {
      record("dispatchTask", input);
      return {
        runId: nextId("run"),
        taskId: input.taskId,
        harness: input.harness ?? DEFAULT_DISPATCH_DEFAULTS.harness,
        kind: input.kind ?? "execute",
        worktreePath: `.nexestra/worktrees/${input.taskId}`,
      };
    },

    async readRunEvents(input: ReadRunEventsInput): Promise<ReadRunEventsResult> {
      record("readRunEvents", input);
      const all = options.runEvents?.[input.runId] ?? [];
      const since = input.sinceSeq ?? 0;
      const events = all.filter((event) => event.seq > since).slice(0, input.limit ?? 100);
      const last = events[events.length - 1];
      return { runId: input.runId, events, nextSeq: last ? last.seq : since, truncated: false };
    },

    async readArtifact(input: ReadArtifactInput): Promise<ReadArtifactResult> {
      record("readArtifact", input);
      const found = options.artifacts?.[input.artifactId];
      if (!found) throw new Error(`unknown artifact \`${input.artifactId}\``);
      return {
        artifact: {
          id: input.artifactId,
          kind: found.kind as ReadArtifactResult["artifact"]["kind"],
          title: found.title,
        },
        content: found.content,
        truncated: false,
      };
    },

    async controlRun(input: ControlRunInput) {
      record("controlRun", input);
      return { ok: true };
    },

    async runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
      record("runVerification", input);
      const ids = input.criterionIds ?? Object.keys(options.verification ?? {});
      const outcomes = ids.map(
        (criterionId): VerificationOutcome =>
          options.verification?.[criterionId] ?? {
            criterionId,
            passed: true,
            evidenceArtifactId: nextId("art"),
            exitCode: 0,
          },
      );
      return { taskId: input.taskId, outcomes };
    },

    async markCriterion(input: MarkCriterionInput): Promise<MarkCriterionResult> {
      record("markCriterion", input);
      return { criterionId: input.criterionId, satisfied: input.passed };
    },

    async summarize(input: SummarizeInput) {
      record("summarize", input);
      return { ok: true };
    },

    dispatchDefaults() {
      return options.dispatchDefaults ?? DEFAULT_DISPATCH_DEFAULTS;
    },

    onSpecUpdated(spec) {
      record("onSpecUpdated", { version: spec.version });
    },

    onPlanProposed(plan) {
      record("onPlanProposed", { version: plan.version });
      plans.push(plan);
    },

    onPhaseChanged(from, to, reason) {
      record("onPhaseChanged", { from, to, reason });
      phaseChanges.push({ from, to, reason });
    },
  };
}
