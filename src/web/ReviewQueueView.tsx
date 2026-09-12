import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewQueueItem, ReviewQueuePage } from "../shared/contracts.js";
import { ReviewQueuePageSchema } from "../shared/contracts.js";
import { api } from "./api.js";
import "./ReviewQueueView.css";

const PAGE_LIMIT = 25;

export interface ReviewQueueViewProps {
  workspaceId: string;
  refreshRevision?: number;
  onOpenMessage: (threadId: string, messageId: string) => void;
}

export function ReviewQueueView({
  workspaceId,
  refreshRevision,
  onOpenMessage,
}: ReviewQueueViewProps) {
  const [page, setPage] = useState<ReviewQueuePage>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams({ workspaceId, limit: String(PAGE_LIMIT) });
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
    [workspaceId],
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

  const rows = page?.items ?? [];
  const nextCursor = page?.page.nextCursor ?? null;

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
        <button type="button" onClick={() => void load()} disabled={loading || loadingMore}>
          Refresh
        </button>
      </header>
      {page?.coverage.complete === false ? (
        <p className="review-queue-warning" role="status">
          Some conversations could not be scanned ({page.coverage.unavailableThreads}).
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
