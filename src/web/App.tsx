import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Columns3,
  Copy,
  LoaderCircle,
  MessageSquareMore,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  Sparkles,
  Unplug,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  AgentRun,
  AgentView,
  BootstrapData,
  Message,
  Task,
  Thread,
  ThreadData,
} from "../shared/contracts.js";
import { extractMentionHandles, handleFromName } from "../shared/contracts.js";
import { api } from "./api.js";

type PrimaryView = "threads" | "surfaces";
type Surface = "taskboard" | "agents";
type ModalName = "thread" | "agent" | "task" | "settings" | null;

interface RouteState {
  view: PrimaryView;
  surface: Surface;
  threadId?: string;
}

interface LoginSession {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string;
  connected: boolean;
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => routeFromLocation());
  const [data, setData] = useState<BootstrapData>();
  const [threadData, setThreadData] = useState<ThreadData>();
  const [modal, setModal] = useState<ModalName>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [taskStatus, setTaskStatus] = useState<Task["status"]>("todo");

  const navigate = useCallback((nextPath: string, nextRoute: RouteState, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextPath);
    setRoute(nextRoute);
    setQuery("");
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const next = await api<BootstrapData>("/api/bootstrap");
      setData(next);
      if (!quiet) setError(undefined);
      return next;
    } catch (caught) {
      if (!quiet) setError(messageFrom(caught));
      return undefined;
    }
  }, []);

  const loadThread = useCallback(async (threadId: string, quiet = false) => {
    try {
      const next = await api<ThreadData>(`/api/threads/${threadId}`);
      setThreadData(next);
      if (!quiet) setError(undefined);
    } catch (caught) {
      if (!quiet) setError(messageFrom(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (route.view !== "threads") return;
    const requested =
      route.threadId && data?.threads.some((thread) => thread.id === route.threadId);
    const threadId = requested ? route.threadId : data?.threads[0]?.id;
    if (!threadId) return;
    if (threadId !== route.threadId) {
      navigate(`/threads/${threadId}`, { view: "threads", surface: route.surface, threadId }, true);
      return;
    }
    void loadThread(threadId);
  }, [data?.threads, loadThread, navigate, route]);

  const hasActiveThreadRuns = threadData?.runs.some(
    (run) => run.status === "queued" || run.status === "running",
  );
  useEffect(() => {
    const delay = hasActiveThreadRuns ? 1_000 : 5_000;
    const timer = window.setInterval(() => {
      void refresh(true);
      if (route.view === "threads" && route.threadId) void loadThread(route.threadId, true);
    }, delay);
    return () => window.clearInterval(timer);
  }, [hasActiveThreadRuns, loadThread, refresh, route.threadId, route.view]);

  const openThread = (threadId: string) =>
    navigate(`/threads/${threadId}`, { view: "threads", surface: route.surface, threadId });
  const openSurface = (surface: Surface) =>
    navigate(`/surfaces/${surface}`, { view: "surfaces", surface });

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(undefined), 2_600);
  };

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation();
      await refresh();
      if (route.threadId) await loadThread(route.threadId, true);
      flash(success);
    } catch (caught) {
      setError(messageFrom(caught));
    }
  };

  if (!data) {
    return (
      <div className="boot-screen">
        <div className="brand-mark">N</div>
        <LoaderCircle className="spin" size={20} />
        <p>{error ?? "Đang mở workspace…"}</p>
        {error && (
          <button type="button" onClick={() => void refresh()}>
            Thử lại
          </button>
        )}
      </div>
    );
  }

  return (
    <main className="app-shell">
      <TopBar
        data={data}
        query={query}
        setQuery={setQuery}
        onThread={openThread}
        onSurface={openSurface}
        onSettings={() => setModal("settings")}
      />
      <Rail
        view={route.view}
        onThreads={() => {
          const threadId = route.threadId ?? data.threads[0]?.id;
          if (threadId) openThread(threadId);
        }}
        onSurfaces={() => openSurface(route.surface)}
        onSettings={() => setModal("settings")}
      />
      <Sidebar
        data={data}
        route={route}
        onThread={openThread}
        onSurface={openSurface}
        onCreate={() => {
          if (route.view === "threads") setModal("thread");
          else if (route.surface === "agents") setModal("agent");
          else {
            setTaskStatus("todo");
            setModal("task");
          }
        }}
      />
      <section className="workspace">
        {route.view === "threads" ? (
          <ThreadView
            data={data}
            threadData={threadData}
            onSend={async (content) => {
              if (!route.threadId) return;
              await api(`/api/threads/${route.threadId}/messages`, {
                method: "POST",
                body: JSON.stringify({ content }),
              });
              await Promise.all([refresh(true), loadThread(route.threadId)]);
            }}
            onRetry={(runId) =>
              mutate(
                () => api(`/api/runs/${runId}/retry`, { method: "POST", body: "{}" }),
                "Đã xếp lại lượt trả lời.",
              )
            }
          />
        ) : route.surface === "agents" ? (
          <AgentsView
            data={data}
            onCreate={() => setModal("agent")}
            onToggle={(agent) =>
              mutate(
                () =>
                  api(`/api/agents/${agent.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !agent.enabled }),
                  }),
                agent.enabled ? `Đã tắt @${agent.handle}.` : `Đã bật @${agent.handle}.`,
              )
            }
            onArchive={(agent) =>
              mutate(
                () =>
                  api(`/api/agents/${agent.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ archived: true }),
                  }),
                `Đã lưu trữ @${agent.handle}.`,
              )
            }
          />
        ) : (
          <Taskboard
            data={data}
            onCreate={(status = "todo") => {
              setTaskStatus(status);
              setModal("task");
            }}
            onMove={(task, status) =>
              mutate(
                () =>
                  api(`/api/tasks/${task.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ status }),
                  }),
                "Đã cập nhật task.",
              )
            }
            onThread={openThread}
          />
        )}
      </section>

      {modal === "thread" && (
        <ThreadDialog
          onClose={() => setModal(null)}
          onCreate={async (name) => {
            try {
              const thread = await api<Thread>("/api/threads", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              await refresh();
              setModal(null);
              openThread(thread.id);
              flash("Đã tạo thread mới.");
            } catch (caught) {
              setError(messageFrom(caught));
              throw caught;
            }
          }}
        />
      )}
      {modal === "agent" && (
        <AgentDialog
          data={data}
          onClose={() => setModal(null)}
          onCreated={async () => {
            await refresh();
            setModal(null);
            flash("Đã tạo agent. Trạng thái runtime hiển thị trong directory.");
          }}
        />
      )}
      {modal === "task" && (
        <TaskDialog
          data={data}
          initialStatus={taskStatus}
          onClose={() => setModal(null)}
          onCreated={async () => {
            await refresh();
            setModal(null);
            flash("Đã thêm task vào board.");
          }}
        />
      )}
      {modal === "settings" && <SettingsDialog data={data} onClose={() => setModal(null)} />}
      {notice && (
        <div className="toast success-toast" role="status" aria-live="polite">
          <Check size={16} />
          {notice}
        </div>
      )}
      {error && (
        <div className="toast error-toast" role="alert" aria-live="assertive">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)} aria-label="Đóng">
            <X size={15} />
          </button>
        </div>
      )}
    </main>
  );
}

function TopBar(props: {
  data: BootstrapData;
  query: string;
  setQuery: (value: string) => void;
  onThread: (id: string) => void;
  onSurface: (surface: Surface) => void;
  onSettings: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);
  const query = props.query.trim().toLowerCase();
  const results = query
    ? [
        ...props.data.threads
          .filter((thread) => thread.name.toLowerCase().includes(query))
          .map((thread) => ({
            id: thread.id,
            label: `# ${thread.name}`,
            type: "Thread",
            action: () => props.onThread(thread.id),
          })),
        ...props.data.agents
          .filter((agent) => `${agent.name} ${agent.handle}`.toLowerCase().includes(query))
          .map((agent) => ({
            id: agent.id,
            label: `@${agent.handle}`,
            type: "Agent",
            action: () => props.onSurface("agents" as const),
          })),
        ...props.data.tasks
          .filter((task) => task.title.toLowerCase().includes(query))
          .map((task) => ({
            id: task.id,
            label: task.title,
            type: "Task",
            action: () => props.onSurface("taskboard" as const),
          })),
      ].slice(0, 8)
    : [];
  return (
    <header className="topbar">
      <div className="traffic-lights" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="global-search">
        <Search size={16} />
        <input
          ref={searchRef}
          aria-label="Tìm thread, task hoặc agent"
          value={props.query}
          onChange={(event) => props.setQuery(event.target.value)}
          placeholder="Tìm thread, task hoặc agent"
        />
        <kbd>⌘/Ctrl K</kbd>
        {query && (
          <div className="search-results">
            {results.length === 0 ? (
              <p>Không tìm thấy kết quả.</p>
            ) : (
              results.map((result) => (
                <button type="button" key={`${result.type}-${result.id}`} onClick={result.action}>
                  <span>{result.label}</span>
                  <small>{result.type}</small>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <button
        className="profile-button"
        type="button"
        aria-label="Mở cài đặt"
        onClick={props.onSettings}
      >
        VN
        <span />
      </button>
    </header>
  );
}

function Rail(props: {
  view: PrimaryView;
  onThreads: () => void;
  onSurfaces: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="app-rail" aria-label="Điều hướng chính">
      <div className="brand-mark">N</div>
      <button
        className={props.view === "threads" ? "rail-item active" : "rail-item"}
        type="button"
        onClick={props.onThreads}
      >
        <span className="rail-icon">
          <MessageSquareMore size={21} />
        </span>
        Threads
      </button>
      <button
        className={props.view === "surfaces" ? "rail-item active" : "rail-item"}
        type="button"
        onClick={props.onSurfaces}
      >
        <span className="rail-icon">
          <Sparkles size={21} />
        </span>
        Surfaces
      </button>
      <button className="rail-item rail-settings" type="button" onClick={props.onSettings}>
        <span className="rail-icon">
          <Settings size={20} />
        </span>
        Cài đặt
      </button>
    </nav>
  );
}

function Sidebar(props: {
  data: BootstrapData;
  route: RouteState;
  onThread: (id: string) => void;
  onSurface: (surface: Surface) => void;
  onCreate: () => void;
}) {
  const visibleAgents = props.data.agents.filter((agent) => !agent.archived);
  return (
    <aside className="sidebar">
      <div className="workspace-title">
        <div>
          Nexestra <ChevronDown size={15} />
        </div>
        <button className="icon-button" type="button" onClick={props.onCreate} aria-label="Tạo mới">
          <Plus size={18} />
        </button>
      </div>
      {props.route.view === "threads" ? (
        <>
          <div className="sidebar-hint">
            <MessageSquareMore size={14} />
            <span>Hội thoại chung</span>
          </div>
          <div className="section-label">
            <span>Threads</span>
            <button type="button" onClick={props.onCreate} aria-label="Tạo thread">
              <Plus size={15} />
            </button>
          </div>
          <div className="sidebar-list">
            {props.data.threads.map((thread) => (
              <button
                className={
                  thread.id === props.route.threadId ? "sidebar-row selected" : "sidebar-row"
                }
                type="button"
                key={thread.id}
                onClick={() => props.onThread(thread.id)}
              >
                <span className="hash">#</span>
                <span className="row-label">{thread.name}</span>
                {thread.messageCount > 0 && <span className="count">{thread.messageCount}</span>}
              </button>
            ))}
          </div>
          <div className="sidebar-rule" />
          <div className="section-label">
            <span>Agent directory</span>
            <span className="count">{visibleAgents.length}</span>
          </div>
          {visibleAgents.slice(0, 6).map((agent) => (
            <button
              className="presence-row"
              type="button"
              key={agent.id}
              onClick={() => props.onSurface("agents")}
            >
              <Avatar agent={agent} small />
              <span>@{agent.handle}</span>
              <i className={`presence-${agent.readiness}`} />
            </button>
          ))}
          {visibleAgents.length === 0 && (
            <button
              className="sidebar-empty"
              type="button"
              onClick={() => props.onSurface("agents")}
            >
              Tạo agent đầu tiên →
            </button>
          )}
        </>
      ) : (
        <>
          <p className="sidebar-kicker">Không gian làm việc</p>
          <div className="sidebar-list surface-list">
            <button
              className={
                props.route.surface === "taskboard" ? "sidebar-row selected" : "sidebar-row"
              }
              type="button"
              onClick={() => props.onSurface("taskboard")}
            >
              <Columns3 size={17} />
              <span className="row-label">Taskboard</span>
              <span className="count">{props.data.tasks.length}</span>
            </button>
            <button
              className={props.route.surface === "agents" ? "sidebar-row selected" : "sidebar-row"}
              type="button"
              onClick={() => props.onSurface("agents")}
            >
              <UsersRound size={17} />
              <span className="row-label">Quản lý agent</span>
              <span className="count">{visibleAgents.length}</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

function ThreadView(props: {
  data: BootstrapData;
  threadData?: ThreadData;
  onSend: (content: string) => Promise<void>;
  onRetry: (runId: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [mentionMenuOpen, setMentionMenuOpen] = useState(true);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mentionAgents = props.data.agents
    .filter((agent) => agent.enabled && !agent.archived)
    .sort((left, right) => Number(canCallAgent(right)) - Number(canCallAgent(left)));
  const mentionMatch = draft.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
  const mentionQuery = mentionMatch?.[2]?.toLowerCase();
  const suggestions = mentionMatch
    ? mentionAgents
        .filter((agent) => !mentionQuery || agent.handle.includes(mentionQuery))
        .slice(0, 6)
    : [];
  const activeAgent = suggestions[activeSuggestion];
  const selectedSuggestionIndex =
    activeAgent && canCallAgent(activeAgent)
      ? activeSuggestion
      : suggestions.findIndex(canCallAgent);

  const transcriptVersion = `${props.threadData?.messages.length ?? 0}:${(
    props.threadData?.runs ?? []
  )
    .map((run) => `${run.id}-${run.status}`)
    .join(",")}`;
  useEffect(() => {
    if (!transcriptVersion) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [transcriptVersion]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    const agentsByHandle = new Map(props.data.agents.map((agent) => [agent.handle, agent]));
    const requestedHandles = extractMentionHandles(content);
    const unknownHandles = requestedHandles.filter((handle) => !agentsByHandle.has(handle));
    if (unknownHandles.length > 0) {
      setLocalError(`Không tìm thấy ${unknownHandles.map((handle) => `@${handle}`).join(", ")}.`);
      return;
    }
    const unavailable = requestedHandles
      .map((handle) => agentsByHandle.get(handle))
      .find((agent) => agent && !canCallAgent(agent));
    if (unavailable) {
      setLocalError(`@${unavailable.handle} chưa thể gọi: ${unavailable.readinessLabel}.`);
      return;
    }
    setSending(true);
    setLocalError(undefined);
    try {
      await props.onSend(content);
      setDraft("");
      setMentionMenuOpen(true);
    } catch (caught) {
      setLocalError(messageFrom(caught));
    } finally {
      setSending(false);
    }
  };

  const pickMention = (agent: AgentView) => {
    if (!canCallAgent(agent) || !mentionMatch || mentionMatch.index === undefined) return;
    const prefixLength = mentionMatch[1]?.length ?? 0;
    const start = mentionMatch.index + prefixLength;
    setDraft(`${draft.slice(0, start)}@${agent.handle} `);
    setMentionMenuOpen(false);
  };

  const moveSuggestion = (direction: 1 | -1) => {
    const callable = suggestions
      .map((agent, index) => ({ agent, index }))
      .filter(({ agent }) => canCallAgent(agent));
    if (callable.length === 0) return;
    const current = callable.findIndex(({ index }) => index === selectedSuggestionIndex);
    const next = (current + direction + callable.length) % callable.length;
    setActiveSuggestion(callable[next]?.index ?? 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const menuVisible = mentionMenuOpen && suggestions.length > 0;
    if (menuVisible && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      moveSuggestion(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (menuVisible && event.key === "Escape") {
      event.preventDefault();
      setMentionMenuOpen(false);
      return;
    }
    const selected = suggestions[selectedSuggestionIndex];
    if (
      menuVisible &&
      selected &&
      canCallAgent(selected) &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
    ) {
      event.preventDefault();
      pickMention(selected);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const thread = props.threadData?.thread;
  const agentsById = new Map(props.data.agents.map((agent) => [agent.id, agent]));
  const knownHandles = new Set(props.data.agents.map((agent) => agent.handle));
  const latestRuns = latestAttempts(props.threadData?.runs ?? []);
  if (!thread || !props.threadData) {
    return (
      <div className="surface-loading">
        <LoaderCircle className="spin" size={20} /> Đang đọc transcript…
      </div>
    );
  }
  return (
    <div className="thread-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">THREAD</p>
          <h1># {thread.name}</h1>
        </div>
        <div className="thread-summary">
          <UsersRound size={16} />
          <span>{props.data.agents.filter((agent) => !agent.archived).length} agents</span>
          <i />
          Transcript chung
        </div>
      </header>
      <div className="thread-tabs">
        <span className="active">Tin nhắn</span>
        <span>{thread.messageCount} messages</span>
      </div>
      <div className="message-scroll">
        <div className="thread-intro">
          <span className="channel-badge">#</span>
          <h2>{thread.name}</h2>
          <p>
            Mọi người và agent cùng dùng một transcript. Gửi tin bình thường để ghi chú; thêm{" "}
            <mark>@agent</mark> khi bạn muốn agent trả lời.
          </p>
        </div>
        {props.threadData.messages.length > 0 && (
          <div className="date-divider">
            <span>Hôm nay</span>
          </div>
        )}
        {props.threadData.messages.map((message) => (
          <div key={message.id}>
            <MessageRow
              message={message}
              knownHandles={knownHandles}
              agent={
                message.author.kind === "agent" ? agentsById.get(message.author.id) : undefined
              }
            />
            {latestRuns
              .filter((run) => run.triggerMessageId === message.id)
              .map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  agent={agentsById.get(run.agentId)}
                  onRetry={props.onRetry}
                />
              ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="composer-wrap">
        {mentionMenuOpen && suggestions.length > 0 && (
          <div
            className="mention-menu"
            id="mention-suggestions"
            role="listbox"
            aria-label="Chọn agent"
          >
            <p>Gọi agent</p>
            {suggestions.map((agent, index) => (
              <button
                type="button"
                role="option"
                id={`mention-option-${agent.id}`}
                aria-selected={index === selectedSuggestionIndex}
                aria-disabled={!canCallAgent(agent)}
                disabled={!canCallAgent(agent)}
                className={index === selectedSuggestionIndex ? "active" : ""}
                key={agent.id}
                onClick={() => pickMention(agent)}
                onMouseEnter={() => setActiveSuggestion(index)}
              >
                <Avatar agent={agent} small />
                <span>
                  <strong>@{agent.handle}</strong>
                  <small>{agent.kind === "master" ? "Master" : `${agent.harness} worker`}</small>
                </span>
                <em>{agent.readinessLabel}</em>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            aria-label="Tin nhắn"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mentionMenuOpen && suggestions.length > 0}
            aria-controls="mention-suggestions"
            aria-activedescendant={
              mentionMenuOpen && suggestions[selectedSuggestionIndex]
                ? `mention-option-${suggestions[selectedSuggestionIndex].id}`
                : undefined
            }
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setMentionMenuOpen(true);
              setActiveSuggestion(0);
              setLocalError(undefined);
            }}
            onKeyDown={onKeyDown}
            placeholder={`Nhắn #${thread.slug} — gõ @ để gọi agent`}
            rows={2}
          />
          <div className="composer-toolbar">
            <div>
              <button
                className="mention-button"
                type="button"
                onClick={() => {
                  setMentionMenuOpen(true);
                  setActiveSuggestion(0);
                  setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@`);
                }}
                aria-label="Gọi agent"
              >
                @
              </button>
              <span>Agent chỉ trả lời khi được @mention</span>
            </div>
            <button
              className="send-button"
              type="button"
              onClick={() => void send()}
              disabled={!draft.trim() || sending}
              aria-label="Gửi"
            >
              {sending ? <LoaderCircle className="spin" size={17} /> : <SendHorizontal size={17} />}
            </button>
          </div>
        </div>
        <p>
          <kbd>Enter</kbd> để gửi · <kbd>Shift Enter</kbd> để xuống dòng
        </p>
        {localError && (
          <p className="inline-error">
            <CircleAlert size={13} />
            {localError}
          </p>
        )}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  agent,
  knownHandles,
}: {
  message: Message;
  agent?: AgentView;
  knownHandles: ReadonlySet<string>;
}) {
  const isAgent = message.author.kind === "agent";
  return (
    <article className="message">
      {isAgent && agent ? (
        <Avatar agent={agent} />
      ) : (
        <span className="avatar avatar-purple">VN</span>
      )}
      <div>
        <div className="message-meta">
          <strong>{message.author.name}</strong>
          {isAgent && (
            <span className="agent-badge">{agent?.kind === "master" ? "MASTER" : "WORKER"}</span>
          )}
          <time>{formatTime(message.createdAt)}</time>
        </div>
        <p>{highlightMentions(message.content, knownHandles)}</p>
      </div>
    </article>
  );
}

function RunRow({
  run,
  agent,
  onRetry,
}: {
  run: AgentRun;
  agent?: AgentView;
  onRetry: (id: string) => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (run.status === "completed") return null;
  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="typing-row">
        {agent ? <Avatar agent={agent} small /> : <span className="avatar avatar-blue">A</span>}
        <span>
          <b>@{agent?.handle ?? "agent"}</b>{" "}
          {run.status === "queued" ? "đang chờ lượt" : "đang đọc transcript"}
        </span>
        <span className="typing-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    );
  }
  return (
    <div className="run-error">
      <CircleAlert size={15} />
      <div>
        <strong>@{agent?.handle ?? "agent"} chưa thể trả lời</strong>
        <p>{run.error ?? "Lượt chạy bị gián đoạn."}</p>
      </div>
      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          try {
            await onRetry(run.id);
          } finally {
            setRetrying(false);
          }
        }}
      >
        {retrying ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        {retrying ? "Đang xếp lượt…" : "Thử lại"}
      </button>
    </div>
  );
}

function AgentsView(props: {
  data: BootstrapData;
  onCreate: () => void;
  onToggle: (agent: AgentView) => Promise<unknown>;
  onArchive: (agent: AgentView) => Promise<unknown>;
}) {
  const agents = props.data.agents.filter((agent) => !agent.archived);
  return (
    <div className="surface-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SURFACE</p>
          <h1>Quản lý agent</h1>
          <p className="subtitle">Tạo Master hội thoại hoặc Worker phản hồi qua coding harness.</p>
        </div>
        <button className="primary-button" type="button" onClick={props.onCreate}>
          <Plus size={17} />
          Tạo agent
        </button>
      </header>
      <div className="stat-strip">
        <div>
          <span>Agent hoạt động</span>
          <strong>{agents.filter((agent) => agent.enabled).length}</strong>
        </div>
        <div>
          <span>Master</span>
          <strong>{agents.filter((agent) => agent.kind === "master").length}</strong>
        </div>
        <div>
          <span>Worker</span>
          <strong>{agents.filter((agent) => agent.kind === "worker").length}</strong>
        </div>
        <div>
          <span>Đang trả lời</span>
          <strong className="accent-number">
            {agents.filter((agent) => agent.readiness === "busy").length}
          </strong>
        </div>
      </div>
      {agents.length === 0 ? (
        <EmptyState
          icon={<Bot size={25} />}
          title="Chưa có agent nào"
          body="Tạo một Master agent hoặc Worker agent, sau đó gọi agent bằng @handle trong thread."
          action="Tạo agent đầu tiên"
          onAction={props.onCreate}
        />
      ) : (
        <div className="agents-grid">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onToggle={props.onToggle}
              onArchive={props.onArchive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onToggle,
  onArchive,
}: {
  agent: AgentView;
  onToggle: (agent: AgentView) => Promise<unknown>;
  onArchive: (agent: AgentView) => Promise<unknown>;
}) {
  const detail =
    agent.kind === "worker"
      ? `${agent.harness === "codex" ? "Codex" : "OpenCode"} harness`
      : agent.provider.type === "chatgpt"
        ? `ChatGPT OAuth${agent.provider.model ? ` · ${agent.provider.model}` : ""}`
        : `${agent.provider.name} · ${agent.provider.model}`;
  return (
    <article className="agent-card">
      <div className="agent-card-top">
        <Avatar agent={agent} large />
        <div>
          <h2>{agent.name}</h2>
          <p>@{agent.handle}</p>
        </div>
        <span className={`status-pill status-${agent.readiness}`}>
          <i />
          {agent.readinessLabel}
        </span>
      </div>
      <div className="agent-kind">
        <Bot size={16} />
        <span>{agent.kind.toUpperCase()}</span>
        <b>{detail}</b>
      </div>
      <p className="agent-description">
        {agent.description ||
          (agent.kind === "master"
            ? "Master agent đọc ngữ cảnh chung và phản hồi trong thread."
            : "Worker agent đọc repo và phản hồi qua harness đã chọn.")}
      </p>
      <div className="agent-card-footer">
        <span>
          {!agent.enabled
            ? "Đã ẩn khỏi mention picker"
            : canCallAgent(agent)
              ? "Có thể gọi bằng @mention"
              : `Cần thiết lập: ${agent.readinessLabel}`}
        </span>
        <div>
          <button type="button" onClick={() => void onToggle(agent)}>
            {agent.enabled ? "Tắt" : "Bật"}
          </button>
          <button type="button" className="danger-link" onClick={() => void onArchive(agent)}>
            <Archive size={12} />
            Lưu trữ
          </button>
        </div>
      </div>
    </article>
  );
}

function Taskboard(props: {
  data: BootstrapData;
  onCreate: (status?: Task["status"]) => void;
  onMove: (task: Task, status: Task["status"]) => Promise<unknown>;
  onThread: (id: string) => void;
}) {
  const columns: { status: Task["status"]; title: string }[] = [
    { status: "todo", title: "Cần làm" },
    { status: "in_progress", title: "Đang làm" },
    { status: "done", title: "Hoàn thành" },
  ];
  const agents = new Map(props.data.agents.map((agent) => [agent.id, agent]));
  return (
    <div className="surface-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SURFACE</p>
          <h1>Taskboard</h1>
          <p className="subtitle">
            Board để tổ chức công việc; chỉ @mention trong chat mới kích hoạt agent.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={() => props.onCreate("todo")}>
          <Plus size={17} />
          Tạo task
        </button>
      </header>
      <div className="board">
        {columns.map((column, index) => {
          const tasks = props.data.tasks.filter((task) => task.status === column.status);
          return (
            <section className="board-column" key={column.status}>
              <header>
                <span className={`column-dot dot-${index}`} />
                <h2>{column.title}</h2>
                <span>{tasks.length}</span>
                <button
                  type="button"
                  onClick={() => props.onCreate(column.status)}
                  aria-label={`Tạo task trong ${column.title}`}
                >
                  <Plus size={16} />
                </button>
              </header>
              {tasks.length === 0 && <p className="column-empty">Chưa có task</p>}
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  agent={task.assigneeId ? agents.get(task.assigneeId) : undefined}
                  onMove={props.onMove}
                  onThread={props.onThread}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  agent,
  onMove,
  onThread,
}: {
  task: Task;
  agent?: AgentView;
  onMove: (task: Task, status: Task["status"]) => Promise<unknown>;
  onThread: (id: string) => void;
}) {
  const statuses: Task["status"][] = ["todo", "in_progress", "done"];
  const position = statuses.indexOf(task.status);
  return (
    <article className="task-card">
      <span className="task-id">NX-{task.id.slice(0, 4).toUpperCase()}</span>
      <h3>{task.title}</h3>
      {task.description && <p>{task.description}</p>}
      <footer>
        <div>
          {agent ? (
            <>
              <Avatar agent={agent} small />
              <span>@{agent.handle}</span>
            </>
          ) : (
            <span>Chưa giao</span>
          )}
        </div>
        <div className="task-actions">
          {task.threadId && (
            <button type="button" onClick={() => onThread(task.threadId ?? "")}>
              <MessageSquareMore size={13} />
            </button>
          )}
          <button
            type="button"
            disabled={position === 0}
            onClick={() => void onMove(task, statuses[position - 1] ?? task.status)}
            aria-label="Chuyển sang trái"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            type="button"
            disabled={position === statuses.length - 1}
            onClick={() => void onMove(task, statuses[position + 1] ?? task.status)}
            aria-label="Chuyển sang phải"
          >
            <ArrowRight size={13} />
          </button>
        </div>
      </footer>
    </article>
  );
}

function ThreadDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Tạo thread" eyebrow="NEW THREAD" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          try {
            await onCreate(name);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field label="Tên thread" hint="Ví dụ: product-room">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="product-room"
            required
            maxLength={80}
          />
        </Field>
        <ModalActions onClose={onClose} saving={saving} submitLabel="Tạo thread" />
      </form>
    </Modal>
  );
}

function AgentDialog({
  data,
  onClose,
  onCreated,
}: {
  data: BootstrapData;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [kind, setKind] = useState<"worker" | "master">("worker");
  const [providerMode, setProviderMode] = useState<"chatgpt" | "custom">("chatgpt");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [login, setLogin] = useState<LoginSession>();

  useEffect(() => {
    if (login?.status !== "running") return;
    const timer = window.setInterval(async () => {
      const next = await api<LoginSession>(`/api/auth/chatgpt/${login.id}`).catch(() => undefined);
      if (next) setLogin(next);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [login]);

  const updateName = (value: string) => {
    setName(value);
    if (!handleTouched) setHandle(handleFromName(value));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFormError(undefined);
    const fields = new FormData(event.currentTarget);
    const common = {
      kind,
      name,
      handle,
      description: String(fields.get("description") ?? ""),
      instructions: String(fields.get("instructions") ?? ""),
    };
    const payload =
      kind === "worker"
        ? { ...common, harness: String(fields.get("harness") ?? "codex") }
        : {
            ...common,
            provider:
              providerMode === "chatgpt"
                ? { type: "chatgpt", model: String(fields.get("model") ?? "") }
                : {
                    type: "custom",
                    name: String(fields.get("providerName") ?? ""),
                    baseUrl: String(fields.get("baseUrl") ?? ""),
                    model: String(fields.get("model") ?? ""),
                    protocol: String(fields.get("protocol") ?? "openai-chat"),
                    apiKey: String(fields.get("apiKey") ?? ""),
                  },
          };
    try {
      await api("/api/agents", { method: "POST", body: JSON.stringify(payload) });
      await onCreated();
    } catch (caught) {
      setFormError(messageFrom(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Tạo agent" eyebrow="AGENT DIRECTORY" onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="segmented">
          <button
            type="button"
            className={kind === "worker" ? "active" : ""}
            aria-pressed={kind === "worker"}
            onClick={() => setKind("worker")}
          >
            <Bot size={16} />
            <span>
              <strong>Worker</strong>
              <small>Codex hoặc OpenCode</small>
            </span>
          </button>
          <button
            type="button"
            className={kind === "master" ? "active" : ""}
            aria-pressed={kind === "master"}
            onClick={() => setKind("master")}
          >
            <Sparkles size={16} />
            <span>
              <strong>Master</strong>
              <small>Hội thoại trong Nexestra</small>
            </span>
          </button>
        </div>
        <div className="form-grid">
          <Field label="Tên hiển thị">
            <input
              value={name}
              onChange={(event) => updateName(event.target.value)}
              placeholder={kind === "worker" ? "Codex Builder" : "Maya"}
              required
              maxLength={60}
            />
          </Field>
          <Field label="Handle" hint="Dùng để @mention">
            <div className="handle-input">
              <span>@</span>
              <input
                value={handle}
                onChange={(event) => {
                  setHandleTouched(true);
                  setHandle(event.target.value.toLowerCase());
                }}
                placeholder="agent-name"
                required
                pattern="[a-z0-9][a-z0-9_-]{1,30}"
              />
            </div>
          </Field>
        </div>
        <Field label="Mô tả" optional>
          <input name="description" placeholder="Agent này phụ trách điều gì?" maxLength={240} />
        </Field>
        {kind === "worker" ? (
          <Field label="Harness">
            <div className="choice-cards">
              <label>
                <input type="radio" name="harness" value="codex" defaultChecked />
                <span>
                  <b>Codex</b>
                  <small>
                    {data.runtime.harnesses.codex.installed
                      ? data.runtime.harnesses.codex.version
                      : "Chưa cài"}
                  </small>
                </span>
              </label>
              <label>
                <input type="radio" name="harness" value="opencode" />
                <span>
                  <b>OpenCode</b>
                  <small>
                    {data.runtime.harnesses.opencode.installed
                      ? data.runtime.harnesses.opencode.version
                      : "Chưa cài"}
                  </small>
                </span>
              </label>
            </div>
          </Field>
        ) : (
          <>
            <Field label="Provider">
              <div className="provider-tabs">
                <button
                  type="button"
                  className={providerMode === "chatgpt" ? "active" : ""}
                  aria-pressed={providerMode === "chatgpt"}
                  onClick={() => setProviderMode("chatgpt")}
                >
                  ChatGPT OAuth
                </button>
                <button
                  type="button"
                  className={providerMode === "custom" ? "active" : ""}
                  aria-pressed={providerMode === "custom"}
                  onClick={() => setProviderMode("custom")}
                >
                  OpenAI-compatible
                </button>
              </div>
            </Field>
            {providerMode === "chatgpt" ? (
              <div className="auth-panel">
                <div
                  className={
                    data.runtime.chatgpt.connected || login?.connected
                      ? "auth-icon connected"
                      : "auth-icon"
                  }
                >
                  {data.runtime.chatgpt.connected || login?.connected ? (
                    <Check size={20} />
                  ) : (
                    <Unplug size={20} />
                  )}
                </div>
                <div>
                  <strong>
                    {data.runtime.chatgpt.connected || login?.connected
                      ? "ChatGPT đã kết nối"
                      : "Kết nối tài khoản ChatGPT"}
                  </strong>
                  <p>
                    Nexestra dùng phiên đăng nhập do Codex CLI quản lý và không đọc hoặc lưu OAuth
                    token.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={login?.status === "running"}
                  onClick={async () => {
                    try {
                      setLogin(
                        await api<LoginSession>("/api/auth/chatgpt/start", {
                          method: "POST",
                          body: "{}",
                        }),
                      );
                    } catch (caught) {
                      setFormError(messageFrom(caught));
                    }
                  }}
                >
                  {login?.status === "running"
                    ? "Đang chờ…"
                    : data.runtime.chatgpt.connected
                      ? "Kiểm tra"
                      : "Kết nối"}
                </button>
                {login?.output && <pre>{login.output}</pre>}
                <Field label="Model" optional hint="Để trống để dùng mặc định của Codex">
                  <input name="model" placeholder="Mặc định" />
                </Field>
              </div>
            ) : (
              <CustomProviderFields />
            )}
          </>
        )}
        <Field label="Chỉ dẫn riêng" optional>
          <textarea
            name="instructions"
            rows={3}
            placeholder="Vai trò, cách trả lời, giới hạn của agent…"
            maxLength={8000}
          />
        </Field>
        {formError && (
          <p className="form-error">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <ModalActions onClose={onClose} saving={saving} submitLabel="Tạo agent" />
      </form>
    </Modal>
  );
}

function CustomProviderFields() {
  return (
    <div className="custom-provider">
      <div className="form-grid">
        <Field label="Tên provider">
          <input name="providerName" placeholder="Local gateway" required />
        </Field>
        <Field label="Protocol">
          <select name="protocol" defaultValue="openai-chat">
            <option value="openai-chat">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
          </select>
        </Field>
      </div>
      <Field label="Base URL" hint="API root: HTTPS cho remote; HTTP chỉ dùng được với localhost">
        <input name="baseUrl" type="url" placeholder="https://api.example.com/v1" required />
      </Field>
      <div className="form-grid">
        <Field label="Model ID">
          <input name="model" placeholder="model-name" required />
        </Field>
        <Field label="API key" optional hint="Có thể bỏ trống cho local endpoint">
          <input
            name="apiKey"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••••"
          />
        </Field>
      </div>
      <p className="security-note">
        Chỉ dùng endpoint bạn tin cậy. API key được lưu riêng với quyền chỉ user hiện tại đọc được.
      </p>
    </div>
  );
}

function TaskDialog({
  data,
  initialStatus,
  onClose,
  onCreated,
}: {
  data: BootstrapData;
  initialStatus: Task["status"];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  return (
    <Modal title="Tạo task" eyebrow="TASKBOARD" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setFormError(undefined);
          const fields = new FormData(event.currentTarget);
          try {
            await api("/api/tasks", {
              method: "POST",
              body: JSON.stringify({
                title: String(fields.get("title") ?? ""),
                description: String(fields.get("description") ?? ""),
                status: String(fields.get("status") ?? initialStatus),
                assigneeId: String(fields.get("assigneeId") ?? "") || null,
                threadId: String(fields.get("threadId") ?? "") || null,
              }),
            });
            await onCreated();
          } catch (caught) {
            setFormError(messageFrom(caught));
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field label="Tiêu đề">
          <input name="title" placeholder="Việc cần hoàn thành" required maxLength={160} />
        </Field>
        <Field label="Mô tả" optional>
          <textarea name="description" rows={3} placeholder="Kết quả mong muốn…" />
        </Field>
        <div className="form-grid">
          <Field label="Cột">
            <select name="status" defaultValue={initialStatus}>
              <option value="todo">Cần làm</option>
              <option value="in_progress">Đang làm</option>
              <option value="done">Hoàn thành</option>
            </select>
          </Field>
          <Field label="Giao cho" optional>
            <select name="assigneeId" defaultValue="">
              <option value="">Chưa giao</option>
              {data.agents
                .filter((agent) => !agent.archived)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    @{agent.handle}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="Liên kết thread" optional>
          <select name="threadId" defaultValue="">
            <option value="">Không liên kết</option>
            {data.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                # {thread.name}
              </option>
            ))}
          </select>
        </Field>
        {formError && (
          <p className="form-error">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <ModalActions onClose={onClose} saving={saving} submitLabel="Tạo task" />
      </form>
    </Modal>
  );
}

function SettingsDialog({ data, onClose }: { data: BootstrapData; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Workspace local" eyebrow="SETTINGS" onClose={onClose}>
      <div className="settings-list">
        <div>
          <span>Workspace</span>
          <code>{data.workspacePath}</code>
        </div>
        <div>
          <span>Dữ liệu</span>
          <code>{data.dataPath}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(data.dataPath);
              setCopied(true);
            }}
          >
            <Copy size={13} />
            {copied ? "Đã chép" : "Sao chép"}
          </button>
        </div>
        <div>
          <span>Codex</span>
          <strong className={data.runtime.harnesses.codex.installed ? "ready-text" : "muted-text"}>
            {data.runtime.harnesses.codex.installed
              ? data.runtime.harnesses.codex.version
              : "Chưa cài"}
          </strong>
        </div>
        <div>
          <span>OpenCode</span>
          <strong
            className={data.runtime.harnesses.opencode.installed ? "ready-text" : "muted-text"}
          >
            {data.runtime.harnesses.opencode.installed
              ? data.runtime.harnesses.opencode.version
              : "Chưa cài"}
          </strong>
        </div>
        <div>
          <span>ChatGPT</span>
          <strong className={data.runtime.chatgpt.connected ? "ready-text" : "muted-text"}>
            {data.runtime.chatgpt.connected ? "Đã kết nối" : "Chưa kết nối"}
          </strong>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="primary-button" onClick={onClose}>
          Xong
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  eyebrow,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
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
  return (
    <div className="modal-backdrop">
      <section
        ref={modalRef}
        className={wide ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Đóng">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="field">
      <legend>
        {label}
        {optional && <em>Tùy chọn</em>}
      </legend>
      {children}
      {hint && <small>{hint}</small>}
    </fieldset>
  );
}

function ModalActions({
  onClose,
  saving,
  submitLabel,
}: {
  onClose: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <div className="modal-actions">
      <button type="button" className="secondary-button" onClick={onClose}>
        Hủy
      </button>
      <button type="submit" className="primary-button" disabled={saving}>
        {saving && <LoaderCircle className="spin" size={15} />}
        {submitLabel}
      </button>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      <button type="button" className="primary-button" onClick={onAction}>
        <Plus size={16} />
        {action}
      </button>
    </div>
  );
}

function Avatar({
  agent,
  small = false,
  large = false,
}: {
  agent: AgentView;
  small?: boolean;
  large?: boolean;
}) {
  const tone = ["coral", "blue", "gold", "green"][hashString(agent.handle) % 4];
  return (
    <span
      className={`avatar avatar-${tone}${small ? " avatar-small" : ""}${large ? " avatar-large" : ""}`}
    >
      {agent.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function latestAttempts(runs: AgentRun[]): AgentRun[] {
  const latest = new Map<string, AgentRun>();
  for (const run of runs) {
    const key = `${run.triggerMessageId}:${run.agentId}`;
    const previous = latest.get(key);
    if (!previous || run.attempt >= previous.attempt) latest.set(key, run);
  }
  return [...latest.values()];
}

function canCallAgent(agent: AgentView): boolean {
  return agent.readiness === "ready" || agent.readiness === "busy";
}

function highlightMentions(content: string, knownHandles: ReadonlySet<string>): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /@[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}/g;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) {
      nodes.push(<span key={`text-${cursor}`}>{content.slice(cursor, index)}</span>);
    }
    const handle = match[0].slice(1).toLowerCase();
    nodes.push(
      <mark
        className={knownHandles.has(handle) ? undefined : "unresolved"}
        key={`mention-${index}`}
      >
        {match[0]}
      </mark>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < content.length) {
    nodes.push(<span key={`text-${cursor}`}>{content.slice(cursor)}</span>);
  }
  return nodes;
}

function hashString(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Đã có lỗi xảy ra.";
}

function routeFromLocation(): RouteState {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "surfaces") {
    return { view: "surfaces", surface: parts[1] === "taskboard" ? "taskboard" : "agents" };
  }
  return { view: "threads", surface: "agents", ...(parts[1] ? { threadId: parts[1] } : {}) };
}
