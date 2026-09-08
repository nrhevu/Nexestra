import { LoaderCircle, Search, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  MessageSearchArchivedFilter,
  MessageSearchAuthor,
  MessageSearchHit,
  MessageSearchResponse,
  Thread,
} from "../shared/contracts.js";
import { api } from "./api.js";
import "./MessageSearchDialog.css";

export interface MessageSearchDialogProps {
  workspaceId: string;
  threads: Thread[];
  initialQuery?: string;
  onClose: () => void;
  onOpenMessage: (threadId: string, messageId: string) => void;
}

interface SearchSnapshot {
  query: string;
  threadId: string;
  archived: MessageSearchArchivedFilter;
}

interface SearchMeta {
  matchesFound: number;
  complete: boolean;
  nextOffset: number | null;
}

type SearchPhase = "idle" | "loading" | "ready" | "error";

const PAGE_SIZE = 50;

function authorName(author: MessageSearchAuthor): string {
  return author.kind === "agent" ? `${author.name} (${author.handle})` : author.name;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function matchLabel(count: number): string {
  return `${count} ${count === 1 ? "match" : "matches"}`;
}

function mergeHits(current: MessageSearchHit[], incoming: MessageSearchHit[]): MessageSearchHit[] {
  const seen = new Set(current.map((hit) => `${hit.thread.id}:${hit.messageId}`));
  return [
    ...current,
    ...incoming.filter((hit) => {
      const key = `${hit.thread.id}:${hit.messageId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export function MessageSearchDialog({
  workspaceId,
  threads,
  initialQuery,
  onClose,
  onOpenMessage,
}: MessageSearchDialogProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [threadId, setThreadId] = useState("");
  const [archiveFilter, setArchiveFilter] = useState<MessageSearchArchivedFilter>("all");
  const [submitted, setSubmitted] = useState<SearchSnapshot | null>(null);
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [results, setResults] = useState<MessageSearchHit[]>([]);
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [moreError, setMoreError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dialogRef = useRef<HTMLElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const workspaceRef = useRef(workspaceId);
  const didAutoSearchRef = useRef(false);
  const titleId = useId();

  const invalidatePending = useCallback(() => {
    requestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const threadOptions = useMemo(
    () =>
      threads
        .filter((thread) => thread.workspaceId === workspaceId)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [threads, workspaceId],
  );

  const runSearch = useCallback(
    async (snapshot: SearchSnapshot, offset?: number) => {
      const requestId = ++requestRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setSubmitted(snapshot);
      setErrorMessage("");
      setMoreError("");
      if (offset === undefined) {
        setPhase("loading");
        setResults([]);
        setMeta(null);
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }

      const params = new URLSearchParams({
        workspaceId,
        q: snapshot.query,
        archived: snapshot.archived,
        limit: String(PAGE_SIZE),
      });
      if (snapshot.threadId !== "") params.set("threadId", snapshot.threadId);
      if (offset !== undefined) params.set("offset", String(offset));

      try {
        const response = await api<MessageSearchResponse>(
          `/api/search/messages?${params.toString()}`,
          { signal: controller.signal },
        );
        if (requestId !== requestRef.current || controller.signal.aborted) return;
        setResults((current) =>
          offset === undefined ? response.matches : mergeHits(current, response.matches),
        );
        setMeta({
          matchesFound: response.matchesFound,
          complete: response.complete,
          nextOffset: response.nextOffset,
        });
        setPhase("ready");
      } catch (error) {
        if (requestId !== requestRef.current || controller.signal.aborted) return;
        const message =
          error instanceof Error && error.message !== ""
            ? error.message
            : "Search failed. Please try again.";
        if (offset === undefined) {
          setPhase("error");
          setErrorMessage(message);
        } else {
          setMoreError(message);
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (requestId === requestRef.current) setLoadingMore(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!initialQuery?.trim() || didAutoSearchRef.current) return;
    didAutoSearchRef.current = true;
    void runSearch({ query: initialQuery.trim(), threadId: "", archived: "all" });
  }, [initialQuery, runSearch]);

  useEffect(() => {
    if (workspaceRef.current === workspaceId) return;
    workspaceRef.current = workspaceId;
    invalidatePending();
    setThreadId("");
    setSubmitted(null);
    setPhase("idle");
    setResults([]);
    setMeta(null);
    setErrorMessage("");
    setMoreError("");
    setLoadingMore(false);
  }, [invalidatePending, workspaceId]);

  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queryRef.current?.focus();
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousActive?.focus();
    };
  }, []);

  useEffect(
    () => () => {
      didAutoSearchRef.current = false;
      requestRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const trimmedQuery = query.trim();
  const partial = meta !== null && !meta.complete;
  const canSearch = trimmedQuery !== "";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSearch) return;
    invalidatePending();
    void runSearch({ query: trimmedQuery, threadId, archived: archiveFilter });
  };

  const handleFormChange = () => {
    invalidatePending();
    setSubmitted(null);
    setPhase("idle");
    setResults([]);
    setMeta(null);
    setErrorMessage("");
    setMoreError("");
    setLoadingMore(false);
  };

  const handleRetry = () => {
    const snapshot = submitted ?? { query: trimmedQuery, threadId, archived: archiveFilter };
    if (snapshot.query === "") return;
    invalidatePending();
    void runSearch(snapshot);
  };

  const handleLoadMore = () => {
    if (
      !submitted ||
      !meta?.complete ||
      meta?.nextOffset === null ||
      meta?.nextOffset === undefined ||
      loadingMore
    ) {
      return;
    }
    void runSearch(submitted, meta.nextOffset);
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal modal-wide message-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">MESSAGE SEARCH</p>
            <h2 id={titleId}>Search messages</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <form className="message-search-form" onSubmit={handleSubmit}>
            <label className="field message-search-query" htmlFor="message-search-query">
              <span>Search transcripts</span>
              <input
                id="message-search-query"
                ref={queryRef}
                type="search"
                value={query}
                maxLength={200}
                placeholder="Search messages in this workspace"
                onChange={(event) => {
                  handleFormChange();
                  setQuery(event.target.value);
                }}
              />
            </label>
            <label className="field">
              <span>Thread</span>
              <select
                value={threadId}
                onChange={(event) => {
                  handleFormChange();
                  setThreadId(event.target.value);
                }}
              >
                <option value="">All threads</option>
                {threadOptions.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.name}
                    {thread.archived ? " (Archived)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Archive status</span>
              <select
                value={archiveFilter}
                onChange={(event) => {
                  handleFormChange();
                  setArchiveFilter(event.target.value as MessageSearchArchivedFilter);
                }}
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <div className="message-search-actions">
              <button type="submit" className="primary-button" disabled={!canSearch}>
                <Search size={15} />
                Search
              </button>
            </div>
          </form>

          {phase === "loading" && (
            <p className="message-search-status" role="status">
              <LoaderCircle className="spin" size={15} />
              Searching messages…
            </p>
          )}

          {phase === "error" && (
            <div className="form-error message-search-error" role="alert">
              <span>{errorMessage}</span>
              <button type="button" className="secondary-button" onClick={handleRetry}>
                Retry
              </button>
            </div>
          )}

          {phase === "ready" && meta && (results.length > 0 || meta.complete) && (
            <p className="message-search-count" role="status">
              {partial
                ? `At least ${matchLabel(meta.matchesFound)} in the scanned portion`
                : matchLabel(meta.matchesFound)}
            </p>
          )}

          {partial && results.length > 0 && (
            <p className="message-search-partial">
              Results may be incomplete. Try narrowing the search to a thread.
            </p>
          )}

          {meta?.complete && meta.nextOffset === null && results.length < meta.matchesFound && (
            <p className="message-search-partial">
              Showing {results.length} of {meta.matchesFound} matches. Try a more specific search.
            </p>
          )}

          {phase === "ready" && results.length === 0 && (
            <p className="message-search-empty">
              {meta?.complete === false
                ? "No matching messages found in the scanned portion. Results may be incomplete. Try narrowing the search to a thread."
                : "No messages matched your search."}
            </p>
          )}

          {results.length > 0 && (
            <ul className="message-search-results" aria-label="Search results">
              {results.map((match) => (
                <li key={`${match.thread.id}:${match.messageId}`}>
                  <button
                    type="button"
                    className="message-search-result"
                    onClick={() => onOpenMessage(match.thread.id, match.messageId)}
                  >
                    <span className="message-search-result-title">
                      <strong>{match.thread.name}</strong>
                      {match.thread.archived && (
                        <em className="message-search-archive-badge">Archived</em>
                      )}
                      <time dateTime={match.createdAt}>{formatTime(match.createdAt)}</time>
                    </span>
                    <span className="message-search-result-meta">{authorName(match.author)}</span>
                    <span className="message-search-snippet">{match.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {meta?.complete &&
            meta?.nextOffset !== null &&
            meta?.nextOffset !== undefined &&
            results.length > 0 && (
              <div className="message-search-more">
                {moreError && <p className="form-error">{moreError}</p>}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                >
                  {loadingMore && <LoaderCircle className="spin" size={14} />}
                  Load more
                </button>
              </div>
            )}
        </div>
      </section>
    </div>
  );
}
