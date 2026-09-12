import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentView,
  RunHistoryItem,
  RunHistoryMetrics,
  RunHistoryPage,
  RunHistoryTelemetryResponse,
  Thread,
  Workspace,
} from "../shared/contracts.js";
import {
  RunHistoryPageSchema,
  RunHistoryTelemetryResponseSchema,
  RunSchema,
} from "../shared/contracts.js";
import { api } from "./api.js";
import { runHistoryExportFilename, serializeRunHistoryExport } from "./run-history-export.js";
import "./RunHistoryView.css";

export interface RunHistoryViewProps {
  workspaceId: string;
  initialCostFilter?: "all" | "over_budget";
  agents: AgentView[];
  threads: Thread[];
  workspaces?: Workspace[];
  refreshRevision?: number;
  onOpenRun: (item: RunHistoryItem) => void;
  onRetryRun: (runId: string) => Promise<void>;
}

const PAGE_LIMIT = 50;
const FETCH_TIMEOUT_MS = 30_000;
const AUTO_REFRESH_MS = 15_000;
const RUN_STATUSES = RunSchema.shape.status.options;
type RunStatus = (typeof RUN_STATUSES)[number];

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  waiting_input: "Waiting for input",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

type LoadPhase = "loading" | "ready" | "error";

interface RunPage {
  items: RunHistoryItem[];
  nextCursor: string | null;
  cursor: string | null;
  summary: RunHistoryMetrics;
}

interface RunHistoryViewState {
  workspaceId: string;
  page: RunPage | null;
  previousCursors: Array<string | null>;
  coverage: RunHistoryPage["coverage"] | null;
  phase: LoadPhase;
  errorMessage: string;
  moreError: string;
  loadingMore: boolean;
  failedAction: "older" | "newer" | null;
}

interface RunHistoryFilters {
  workspaceId: string;
  agentId: string;
  threadId: string;
  status: RunStatus | "";
  cost: "all" | "over_budget";
}

function initialViewState(workspaceId: string): RunHistoryViewState {
  return {
    workspaceId,
    page: null,
    previousCursors: [],
    coverage: null,
    phase: "loading",
    errorMessage: "",
    moreError: "",
    loadingMore: false,
    failedAction: null,
  };
}

function statusLabel(status: RunStatus): string {
  return RUN_STATUS_LABELS[status];
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function formatTokens(totalTokens: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    totalTokens,
  );
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value);
}

function formatAgentUsage(agent: RunHistoryMetrics["byAgent"][number]): string {
  if (agent.usageRuns === 0) return "no usage";
  const cached =
    agent.cachedInputTokens > 0 ? ` · ${formatTokens(agent.cachedInputTokens)} cached` : "";
  const cost =
    agent.estimatedCostUsd !== undefined ? ` · ${formatUsd(agent.estimatedCostUsd)}` : "";
  return `${formatTokens(agent.totalTokens)} tokens (${formatTokens(agent.inputTokens)} in / ${formatTokens(agent.outputTokens)} out${cached})${cost}`;
}

function formatAgentFeedback(agent: RunHistoryMetrics["byAgent"][number]): string {
  const total = agent.feedbackCount ?? 0;
  if (total === 0) return "";
  return ` · ${agent.positiveFeedbackCount ?? 0} helpful / ${agent.negativeFeedbackCount ?? 0} needs work`;
}

function formatAgentProfile(
  agent: Pick<RunHistoryMetrics["byAgent"][number], "agentHarness" | "agentModel">,
): string {
  const harness =
    agent.agentHarness === undefined
      ? undefined
      : agent.agentHarness === "codex"
        ? "Codex"
        : agent.agentHarness === "opencode"
          ? "OpenCode"
          : "Custom";
  return [harness, agent.agentModel]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
}

const FAILURE_KIND_LABELS: Record<NonNullable<RunHistoryItem["run"]["failureKind"]>, string> = {
  timeout: "Timed out",
  aborted: "Stopped before completion",
  verification: "Verification failed",
  unavailable: "Agent unavailable",
  provider: "Provider error",
  unknown: "Failure details available in the conversation",
};

function failureKindLabel(kind: RunHistoryItem["run"]["failureKind"]): string | undefined {
  return kind === undefined ? undefined : FAILURE_KIND_LABELS[kind];
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function RunHistoryView({
  workspaceId,
  initialCostFilter = "all",
  agents,
  threads,
  workspaces = [],
  refreshRevision,
  onOpenRun,
  onRetryRun,
}: RunHistoryViewProps) {
  const [filters, setFilters] = useState<RunHistoryFilters>({
    workspaceId,
    agentId: "",
    threadId: "",
    status: "",
    cost: initialCostFilter,
  });
  const [view, setView] = useState(() => initialViewState(workspaceId));
  const [retryingRunId, setRetryingRunId] = useState<string>();
  const [selectedRetryIds, setSelectedRetryIds] = useState<Set<string>>(() => new Set());
  const [batchRetrying, setBatchRetrying] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [telemetry, setTelemetry] = useState<{
    phase: "idle" | "loading" | "ready" | "error";
    summaries: RunHistoryTelemetryResponse;
  }>({ phase: "idle", summaries: [] });

  useEffect(() => {
    setFilters((current) => {
      const nextCost = initialCostFilter;
      return current.cost === nextCost ? current : { ...current, cost: nextCost };
    });
  }, [initialCostFilter]);

  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const filtersKeyRef = useRef<string | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const workspaceIdsKey = workspaces.map((workspace) => workspace.id).join(",");
  const telemetryKey = `${workspaceIdsKey}:${refreshRevision ?? 0}`;

  useEffect(() => {
    if (workspaces.length < 2) {
      setTelemetry({ phase: "idle", summaries: [] });
      return;
    }
    const controller = new AbortController();
    const workspaceIdsPart = telemetryKey.split(":")[0] ?? "";
    const expectedWorkspaceIds = new Set(workspaceIdsPart.split(","));
    setTelemetry((current) => ({ ...current, phase: "loading" }));
    api<unknown>("/api/runs/summary", { signal: controller.signal })
      .then((raw) => {
        const parsed = RunHistoryTelemetryResponseSchema.safeParse(raw);
        if (!parsed.success) throw new Error("Run telemetry response was invalid.");
        setTelemetry({
          phase: "ready",
          summaries: parsed.data.filter((entry) => expectedWorkspaceIds.has(entry.workspaceId)),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setTelemetry((current) => ({ ...current, phase: "error" }));
      });
    return () => controller.abort();
  }, [telemetryKey, workspaces.length]);

  const updateView = useCallback(
    (updater: (current: RunHistoryViewState) => RunHistoryViewState) => {
      setView((current) => (current.workspaceId === workspaceId ? updater(current) : current));
    },
    [workspaceId],
  );

  const requestPage = useCallback(
    async (params: URLSearchParams, controller: AbortController): Promise<RunHistoryPage> => {
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const raw = await withTimeout(
          api<unknown>(`/api/runs?${params.toString()}`, { signal: controller.signal }),
          FETCH_TIMEOUT_MS,
          "Run history request timed out.",
        );
        const parsed = RunHistoryPageSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error("Run history response was invalid.");
        }
        if (parsed.data.workspaceId !== workspaceId) {
          throw new Error("Run history response was for another workspace.");
        }
        return parsed.data;
      } finally {
        clearTimeout(timer);
      }
    },
    [workspaceId],
  );

  const buildParams = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({
        workspaceId: filters.workspaceId,
        limit: String(PAGE_LIMIT),
      });
      if (filters.agentId !== "") params.set("agentId", filters.agentId);
      if (filters.threadId !== "") params.set("threadId", filters.threadId);
      if (filters.status !== "") params.set("status", filters.status);
      if (filters.cost !== "all") params.set("cost", filters.cost);
      if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
      return params;
    },
    [filters],
  );

  const loadFirstPage = useCallback(async () => {
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;
    // Let StrictMode effect replay (setup -> cleanup -> setup) settle before
    // dispatching a network request; the first setup is cancelled by teardown.
    await Promise.resolve();
    if (requestId !== requestRef.current || controller.signal.aborted) return;
    updateView((current) => ({
      ...current,
      page: null,
      previousCursors: [],
      coverage: null,
      phase: "loading",
      errorMessage: "",
      moreError: "",
      loadingMore: false,
      failedAction: null,
    }));
    setSelectedRetryIds(new Set());
    try {
      const response = await requestPage(buildParams(), controller);
      if (requestId !== requestRef.current) return;
      updateView((current) => ({
        ...current,
        page: {
          items: response.items,
          nextCursor: response.page.nextCursor,
          cursor: null,
          summary: response.summary,
        },
        previousCursors: [],
        coverage: response.coverage,
        phase: "ready",
      }));
    } catch (error) {
      if (requestId !== requestRef.current) return;
      updateView((current) => ({
        ...current,
        page: null,
        previousCursors: [],
        coverage: null,
        phase: "error",
        errorMessage: errorText(error, "Loading run history failed."),
        failedAction: null,
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (requestId === requestRef.current) inFlightRef.current = false;
    }
  }, [buildParams, requestPage, updateView]);

  const loadOlder = useCallback(async () => {
    if (inFlightRef.current) return;
    const currentPage = viewRef.current.page;
    if (!currentPage?.nextCursor) return;
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;
    updateView((current) => ({ ...current, moreError: "", loadingMore: true, failedAction: null }));
    try {
      const response = await requestPage(buildParams(currentPage.nextCursor), controller);
      if (requestId !== requestRef.current) return;
      updateView((current) => {
        if (!current.page || current.page.nextCursor !== currentPage.nextCursor) return current;
        return {
          ...current,
          page: {
            items: response.items,
            nextCursor: response.page.nextCursor,
            cursor: currentPage.nextCursor,
            summary: response.summary,
          },
          previousCursors: [...current.previousCursors, current.page.cursor],
          coverage: response.coverage,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      updateView((current) => ({
        ...current,
        loadingMore: false,
        moreError: errorText(error, "Loading older runs failed."),
        failedAction: "older",
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (requestId === requestRef.current) inFlightRef.current = false;
    }
  }, [buildParams, requestPage, updateView]);

  const loadNewer = useCallback(async () => {
    if (inFlightRef.current) return;
    const previousCursors = viewRef.current.previousCursors;
    if (previousCursors.length === 0) return;
    const cursor = previousCursors.at(-1) ?? null;
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    inFlightRef.current = true;
    updateView((current) => ({ ...current, moreError: "", loadingMore: true, failedAction: null }));
    try {
      const response = await requestPage(
        buildParams(cursor === null ? undefined : cursor),
        controller,
      );
      if (requestId !== requestRef.current) return;
      updateView((current) => {
        if (current.previousCursors.at(-1) !== cursor) return current;
        return {
          ...current,
          page: {
            items: response.items,
            nextCursor: response.page.nextCursor,
            cursor,
            summary: response.summary,
          },
          previousCursors: current.previousCursors.slice(0, -1),
          coverage: response.coverage,
          loadingMore: false,
        };
      });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      updateView((current) => ({
        ...current,
        loadingMore: false,
        moreError: errorText(error, "Loading newer runs failed."),
        failedAction: "newer",
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (requestId === requestRef.current) inFlightRef.current = false;
    }
  }, [buildParams, requestPage, updateView]);

  useEffect(() => {
    if (filters.workspaceId === workspaceId) return;
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    inFlightRef.current = false;
    filtersKeyRef.current = null;
    revisionRef.current = undefined;
    setFilters({ workspaceId, agentId: "", threadId: "", status: "", cost: "all" });
    setView(initialViewState(workspaceId));
  }, [filters.workspaceId, workspaceId]);

  useEffect(() => {
    if (filters.workspaceId !== workspaceId) return;
    const filtersKey = JSON.stringify(filters);
    const revisionChanged = refreshRevision !== revisionRef.current;
    const filtersChanged = filtersKeyRef.current !== filtersKey;
    if (!revisionChanged && !filtersChanged) return;
    revisionRef.current = refreshRevision;
    filtersKeyRef.current = filtersKey;
    void loadFirstPage();
  }, [filters, refreshRevision, loadFirstPage, workspaceId]);

  useEffect(
    () => () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      inFlightRef.current = false;
      // Reset dedupe state so a StrictMode remount replay starts a fresh request.
      filtersKeyRef.current = null;
      revisionRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (viewRef.current.previousCursors.length === 0 && !inFlightRef.current) {
        void loadFirstPage();
      }
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadFirstPage]);

  const agentOptions = useMemo(
    () =>
      agents
        .filter((agent) => agent.workspaceId === workspaceId)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    [agents, workspaceId],
  );

  const threadOptions = useMemo(
    () =>
      threads
        .filter((thread) => thread.workspaceId === workspaceId)
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    [threads, workspaceId],
  );

  const currentWorkspace = view.workspaceId === workspaceId;
  const rows = currentWorkspace ? (view.page?.items ?? []) : [];
  const nextCursor = currentWorkspace ? (view.page?.nextCursor ?? null) : null;
  const hasNewer = currentWorkspace ? view.previousCursors.length > 0 : false;
  const pageNumber = currentWorkspace ? view.previousCursors.length + 1 : 1;
  const loading = currentWorkspace && view.phase === "loading";
  const busy = loading || view.loadingMore || batchRetrying;
  const summary = currentWorkspace ? view.page?.summary : undefined;

  const exportLoadedRuns = () => {
    if (!view.page || !summary || rows.length === 0 || view.coverage === null) return;
    const blob = new Blob(
      [
        serializeRunHistoryExport({
          workspaceId,
          items: rows,
          summary,
          coverage: view.coverage,
          filters: {
            agentId: filters.agentId || null,
            threadId: filters.threadId || null,
            status: filters.status || null,
            ...(filters.cost === "all" ? {} : { cost: filters.cost }),
          },
          page: {
            number: pageNumber,
            cursor: view.page.cursor,
            nextCursor: view.page.nextCursor,
          },
        }),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = runHistoryExportFilename(workspaceId);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleAgentChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setFilters((current) => ({ ...current, agentId: event.target.value }));
  };

  const handleThreadChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setFilters((current) => ({ ...current, threadId: event.target.value }));
  };

  const retryRun = async (runId: string) => {
    setRetryingRunId(runId);
    try {
      await onRetryRun(runId);
    } finally {
      setRetryingRunId((current) => (current === runId ? undefined : current));
    }
  };

  const retryableRows = rows.filter(
    (item) => item.run.status === "failed" || item.run.status === "interrupted",
  );
  const selectedRetryRows = retryableRows.filter((item) => selectedRetryIds.has(item.run.id));
  const retrySelected = async () => {
    if (selectedRetryRows.length === 0 || batchRetrying) return;
    setBatchRetrying(true);
    try {
      for (const item of selectedRetryRows) await onRetryRun(item.run.id);
      setSelectedRetryIds(new Set());
    } finally {
      setBatchRetrying(false);
    }
  };

  return (
    <section className="run-history-view" aria-label="Run history">
      <header className="run-history-header">
        <h1 className="run-history-heading">Run history</h1>
        <button
          type="button"
          className="run-history-refresh"
          aria-label="Refresh run history"
          disabled={busy}
          onClick={() => void loadFirstPage()}
        >
          Refresh run history
        </button>
        {retryableRows.length > 0 ? (
          <button
            type="button"
            className="run-history-retry-selected"
            disabled={busy || batchRetrying || selectedRetryRows.length === 0}
            onClick={() => void retrySelected()}
          >
            {batchRetrying ? "Retrying selected…" : `Retry selected (${selectedRetryRows.length})`}
          </button>
        ) : null}
        <button
          type="button"
          className="run-history-export"
          onClick={exportLoadedRuns}
          disabled={busy || rows.length === 0}
        >
          Export loaded runs
        </button>
        <label className="run-history-auto-refresh">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          Auto-refresh newest page
        </label>
      </header>

      <fieldset className="run-history-filters">
        <legend className="run-history-legend">Run history filters</legend>
        <label className="run-history-filter">
          <span>Run status</span>
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: event.target.value as RunStatus | "",
              }))
            }
            disabled={!currentWorkspace}
          >
            <option value="">All statuses</option>
            {RUN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {RUN_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="run-history-filter">
          <span>Cost filter</span>
          <select
            aria-label="Run cost"
            value={filters.cost}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                cost: event.target.value as RunHistoryFilters["cost"],
              }))
            }
            disabled={!currentWorkspace}
          >
            <option value="all">All costs</option>
            <option value="over_budget">Over budget only</option>
          </select>
        </label>
        <label className="run-history-filter">
          <span>Run agent</span>
          <select value={filters.agentId} onChange={handleAgentChange} disabled={!currentWorkspace}>
            <option value="">All agents</option>
            {agentOptions.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.archived ? `${agent.name} (archived)` : agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="run-history-filter">
          <span>Run conversation</span>
          <select
            value={filters.threadId}
            onChange={handleThreadChange}
            disabled={!currentWorkspace}
          >
            <option value="">All conversations</option>
            {threadOptions.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.archived ? `${thread.name} (archived)` : thread.name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {summary ? (
        <>
          <dl className="run-history-summary" aria-label="Run history summary">
            <div>
              <dt>Runs</dt>
              <dd>{summary.totalRuns}</dd>
            </div>
            <div>
              <dt>Terminal time</dt>
              <dd>{formatDuration(summary.totalDurationMs)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{summary.usageRuns > 0 ? formatTokens(summary.totalTokens) : "—"}</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>
                {summary.estimatedCostUsd !== undefined ? formatUsd(summary.estimatedCostUsd) : "—"}
              </dd>
            </div>
            <div>
              <dt>Cost coverage</dt>
              <dd>
                {(summary.estimatedCostRuns ?? 0) > 0
                  ? `${summary.estimatedCostRuns}/${summary.totalRuns}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Usage coverage</dt>
              <dd>
                {summary.usageRuns}/{summary.totalRuns}
              </dd>
            </div>
            <div>
              <dt>Helpful / needs work</dt>
              <dd>
                {(summary.feedbackCount ?? 0) > 0
                  ? `${summary.positiveFeedbackCount ?? 0}/${summary.negativeFeedbackCount ?? 0}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Cost per helpful</dt>
              <dd>
                {summary.estimatedCostPerHelpfulUsd !== undefined
                  ? formatUsd(summary.estimatedCostPerHelpfulUsd)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Over budget</dt>
              <dd>{summary.overBudgetRuns ?? 0}</dd>
            </div>
          </dl>
          {summary.byAgent.length > 0 ? (
            <section className="run-history-agent-breakdown" aria-label="Run history by agent">
              <h2>By agent</h2>
              <ul>
                {summary.byAgent.map((agent) => (
                  <li key={agent.agentId}>
                    <span className="run-history-breakdown-name">
                      <span>{agent.agentName}</span>
                      {formatAgentProfile(agent) ? (
                        <span className="run-history-agent-profile">
                          {formatAgentProfile(agent)}
                        </span>
                      ) : null}
                    </span>
                    <span className="run-history-breakdown-meta">
                      {agent.totalRuns} {agent.totalRuns === 1 ? "run" : "runs"} ·{" "}
                      {formatAgentUsage(agent)}
                      {formatAgentFeedback(agent)} · {formatDuration(agent.totalDurationMs)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {telemetry.phase === "ready" && telemetry.summaries.length > 1 ? (
            <section className="run-history-telemetry" aria-label="Run telemetry by workspace">
              <h2>Workspace comparison</h2>
              <div className="run-history-telemetry-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Workspace</th>
                      <th scope="col">Runs</th>
                      <th scope="col">Tokens</th>
                      <th scope="col">Estimated cost</th>
                      <th scope="col">Over budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {telemetry.summaries.map((entry) => {
                      const workspace = workspaces.find(
                        (candidate) => candidate.id === entry.workspaceId,
                      );
                      return (
                        <tr key={entry.workspaceId}>
                          <th scope="row">{workspace?.name ?? entry.workspaceId}</th>
                          <td>{entry.totalRuns}</td>
                          <td>{entry.usageRuns > 0 ? formatTokens(entry.totalTokens) : "—"}</td>
                          <td>
                            {entry.estimatedCostUsd !== undefined
                              ? formatUsd(entry.estimatedCostUsd)
                              : "—"}
                          </td>
                          <td>{entry.overBudgetRuns ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {currentWorkspace && view.phase === "loading" ? (
        <p className="run-history-status-text" role="status">
          Loading run history…
        </p>
      ) : null}

      {currentWorkspace && view.phase === "error" ? (
        <div className="run-history-error" role="alert">
          <p>{view.errorMessage}</p>
          <button type="button" onClick={() => void loadFirstPage()}>
            Retry
          </button>
        </div>
      ) : null}

      {currentWorkspace && view.phase === "ready" ? (
        <>
          {view.coverage !== null && !view.coverage.complete ? (
            <p className="run-history-warning" role="status">
              Run history is incomplete: {view.coverage.unavailableThreads} conversation
              {view.coverage.unavailableThreads === 1 ? "" : "s"} could not be scanned.
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className="run-history-empty">
              {view.coverage !== null && !view.coverage.complete
                ? "No run history available. Some conversations could not be scanned."
                : "No runs found."}
            </p>
          ) : (
            <ul className="run-history-list">
              {rows.map((item) => (
                <li key={`${item.run.threadId}:${item.run.id}`} className="run-history-row">
                  <article className="run-history-item" aria-label={`Run ${item.run.id}`}>
                    {item.run.status === "failed" || item.run.status === "interrupted" ? (
                      <label className="run-history-select-retry">
                        <input
                          type="checkbox"
                          aria-label={`Select run ${item.run.id} for retry`}
                          checked={selectedRetryIds.has(item.run.id)}
                          disabled={busy || batchRetrying || retryingRunId !== undefined}
                          onChange={() => {
                            setSelectedRetryIds((current) => {
                              const next = new Set(current);
                              if (next.has(item.run.id)) next.delete(item.run.id);
                              else next.add(item.run.id);
                              return next;
                            });
                          }}
                        />
                      </label>
                    ) : null}
                    <div className="run-history-main">
                      <div className="run-history-identity">
                        <span className="run-history-agent">
                          {item.agentName}
                          {item.agentHandle !== undefined ? ` (${item.agentHandle})` : ""}
                          {formatAgentProfile(item) ? (
                            <span className="run-history-agent-profile">
                              {formatAgentProfile(item)}
                            </span>
                          ) : null}
                        </span>
                        <span className="run-history-thread">
                          {item.threadName}
                          {item.threadArchived ? " (archived)" : ""}
                        </span>
                        {item.taskTitle ? (
                          <span className="run-history-task">Task: {item.taskTitle}</span>
                        ) : null}
                      </div>
                      <div className="run-history-meta">
                        <span
                          className={`run-history-status run-history-status--${item.run.status}`}
                        >
                          {statusLabel(item.run.status)}
                        </span>
                        <span className="run-history-attempt">Attempt {item.run.attempt}</span>
                        {item.run.durationMs !== undefined ? (
                          <span className="run-history-duration">
                            Duration {formatDuration(item.run.durationMs)}
                          </span>
                        ) : null}
                        {item.run.usage ? (
                          <span className="run-history-usage" title="Provider-reported token usage">
                            Tokens {formatTokens(item.run.usage.totalTokens)}
                          </span>
                        ) : null}
                        {item.estimatedCostUsd !== undefined ? (
                          <span
                            className="run-history-cost"
                            title="Estimated from this agent's local pricing profile"
                          >
                            Cost {formatUsd(item.estimatedCostUsd)}
                          </span>
                        ) : null}
                        {item.overBudget ? (
                          <span
                            className="run-history-cost run-history-cost--over-budget"
                            title="Observed estimated cost exceeded this agent's configured per-run limit"
                          >
                            Over budget
                          </span>
                        ) : null}
                        <time className="run-history-date" dateTime={item.run.createdAt}>
                          Created {formatDate(item.run.createdAt)}
                        </time>
                        <time className="run-history-date" dateTime={item.run.updatedAt}>
                          Updated {formatDate(item.run.updatedAt)}
                        </time>
                      </div>
                      {failureKindLabel(item.run.failureKind) && (
                        <p className="run-history-error-detail">
                          {failureKindLabel(item.run.failureKind)}. Open the conversation for
                          details.
                        </p>
                      )}
                    </div>
                    <div className="run-history-actions">
                      {(item.run.status === "failed" || item.run.status === "interrupted") && (
                        <button
                          type="button"
                          className="run-history-retry"
                          aria-label={`Retry run ${item.run.id}`}
                          disabled={busy || retryingRunId !== undefined || batchRetrying}
                          onClick={() => void retryRun(item.run.id)}
                        >
                          {retryingRunId === item.run.id ? "Retrying…" : "Retry run"}
                        </button>
                      )}
                      <button
                        type="button"
                        className="run-history-open"
                        aria-label={`Open run: ${item.agentName} in #${item.threadName}`}
                        onClick={() => onOpenRun(item)}
                      >
                        Open run
                      </button>
                    </div>
                  </article>
                </li>
              ))}
            </ul>
          )}
          <fieldset className="run-history-pagination">
            <legend className="run-history-legend">Run history pages</legend>
            <button
              type="button"
              className="run-history-newer"
              aria-label="Newer runs"
              disabled={!hasNewer || busy}
              onClick={() => void loadNewer()}
            >
              Newer runs
            </button>
            <span className="run-history-page-indicator" aria-live="polite">
              Page {pageNumber}
            </span>
            <button
              type="button"
              className="run-history-older"
              aria-label="Older runs"
              disabled={!nextCursor || busy}
              onClick={() => void loadOlder()}
            >
              Older runs
            </button>
          </fieldset>
          {view.moreError !== "" ? (
            <p className="run-history-more-error" role="alert">
              {view.moreError}
              <button
                type="button"
                onClick={() => void (view.failedAction === "newer" ? loadNewer() : loadOlder())}
              >
                Retry
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
