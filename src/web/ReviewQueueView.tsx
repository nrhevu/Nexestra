import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentView, ReviewQueueItem, ReviewQueuePage, Thread } from "../shared/contracts.js";
import { ReviewQueuePageSchema } from "../shared/contracts.js";
import { api } from "./api.js";
import { reviewQueueExportFilename, serializeReviewQueueExport } from "./review-queue-export.js";
import "./ReviewQueueView.css";

const PAGE_LIMIT = 25;

export interface ReviewQueueViewProps {
  workspaceId: string;
  agents?: AgentView[];
  threads?: Thread[];
  refreshRevision?: number;
  onOpenMessage: (threadId: string, messageId: string) => void;
  onCaptureMessage?: (item: ReviewQueueItem) => void;
  onSetReviewStatus: (
    threadId: string,
    messageId: string,
    status: "open" | "resolved",
  ) => Promise<void>;
}

type ReviewFilter = "open" | "resolved" | "all";

export function ReviewQueueView({
  workspaceId,
  agents = [],
  threads = [],
  refreshRevision,
  onOpenMessage,
  onCaptureMessage,
  onSetReviewStatus,
}: ReviewQueueViewProps) {
  const [page, setPage] = useState<ReviewQueuePage>();
  const [status, setStatus] = useState<ReviewFilter>("open");
  const [agentId, setAgentId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resolvingId, setResolvingId] = useState<string>();
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams({
          workspaceId,
          status,
          limit: String(PAGE_LIMIT),
        });
        if (agentId) params.set("agentId", agentId);
        if (threadId) params.set("threadId", threadId);
        if (cursor) params.set("cursor", cursor);
        const parsed = ReviewQueuePageSchema.parse(
          await api<unknown>(`/api/reviews?${params.toString()}`),
        );
        if (requestId !== requestRef.current) return;
        setPage((current) =>
          append && current ? { ...parsed, items: [...current.items, ...parsed.items] } : parsed,
        );
      } catch (caught) {
        if (requestId !== requestRef.current) return;
        setError(caught instanceof Error ? caught.message : "Review queue could not be loaded.");
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [agentId, status, threadId, workspaceId],
  );

  useEffect(() => {
    requestRef.current += 1;
    setPage(undefined);
    void refreshRevision;
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load, refreshRevision]);

  const updateReviewStatus = async (item: ReviewQueueItem) => {
    const nextStatus = item.feedback.reviewStatus === "resolved" ? "open" : "resolved";
    setResolvingId(item.id);
    try {
      await onSetReviewStatus(item.message.threadId, item.message.id, nextStatus);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review status could not be updated.");
    } finally {
      setResolvingId((current) => (current === item.id ? undefined : current));
    }
  };

  const rows = page?.items ?? [];
  const nextCursor = page?.page.nextCursor ?? null;

  const exportLoadedReviews = () => {
    if (!page || rows.length === 0) return;
    const blob = new Blob(
      [serializeReviewQueueExport(page, status, undefined, { agentId, threadId })],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reviewQueueExportFilename(workspaceId);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="review-queue-view" aria-label="Needs-work review queue">
      <header className="review-queue-header">
        <div>
          <p className="eyebrow">QUALITY LOOP</p>
          <h1>Needs-work review</h1>
          <p className="subtitle">
            Revisit responses marked for correction before turning them into Knowledge.
          </p>
        </div>
        <div className="review-queue-header-actions">
          <button type="button" onClick={() => void load()} disabled={loading || loadingMore}>
            Refresh
          </button>
          <button
            type="button"
            onClick={exportLoadedReviews}
            disabled={loading || loadingMore || rows.length === 0}
          >
            Export loaded reviews
          </button>
        </div>
      </header>
      <div className="review-queue-filters">
        <label className="review-queue-filter">
          <span>Review status</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ReviewFilter)}
            disabled={loading || loadingMore}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="review-queue-filter">
          <span>Agent</span>
          <select
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={loading || loadingMore}
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} (@{agent.handle})
              </option>
            ))}
          </select>
        </label>
        <label className="review-queue-filter">
          <span>Thread</span>
          <select
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
            disabled={loading || loadingMore}
          >
            <option value="">All threads</option>
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.name}
                {thread.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {page?.coverage.complete === false ? (
        <p className="review-queue-warning" role="status">
          Some conversations could not be scanned ({page.coverage.unavailableThreads}).
        </p>
      ) : null}
      {page && !loading && !error ? (
        <p className="review-queue-total" role="status">
          {page.total} {page.total === 1 ? "matching review" : "matching reviews"}
        </p>
      ) : null}
      {loading ? <p className="review-queue-status">Loading review queue…</p> : null}
      {error ? (
        <div className="review-queue-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && rows.length === 0 ? (
        <div className="review-queue-empty">
          <h2>Nothing waiting for review</h2>
          <p>Mark an agent response as needs work to keep it here for a deliberate follow-up.</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className="review-queue-list">
          {rows.map((item: ReviewQueueItem) => {
            return (
              <li key={item.id} className="review-queue-item">
                <div className="review-queue-item-meta">
                  <strong>{item.agent.name}</strong>
                  <span>#{item.thread.name}</span>
                  <time dateTime={item.feedback.updatedAt}>
                    {new Date(item.feedback.updatedAt).toLocaleString()}
                  </time>
                </div>
                {item.prompt ? (
                  <p className="review-queue-prompt">
                    <strong>Prompt:</strong> {item.prompt.content}
                  </p>
                ) : null}
                <p className="review-queue-content">{item.message.content}</p>
                {item.feedback.note ? (
                  <p className="review-queue-note">Note: {item.feedback.note}</p>
                ) : null}
                <button
                  type="button"
                  onClick={() => onOpenMessage(item.message.threadId, item.message.id)}
                >
                  Open response
                </button>
                {onCaptureMessage ? (
                  <button type="button" onClick={() => onCaptureMessage(item)}>
                    Capture as Knowledge
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={resolvingId !== undefined}
                  onClick={() => void updateReviewStatus(item)}
                >
                  {resolvingId === item.id
                    ? "Saving…"
                    : item.feedback.reviewStatus === "resolved"
                      ? "Reopen review"
                      : "Mark reviewed"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {nextCursor ? (
        <div className="review-queue-pagination">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => {
              void load(nextCursor, true);
            }}
          >
            {loadingMore ? "Loading…" : "Older reviews"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
