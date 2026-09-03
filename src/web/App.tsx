import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CircleAlert,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Link as LinkIcon,
  LoaderCircle,
  MessageSquareMore,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  Sparkles,
  TerminalSquare,
  Trash2,
  Unplug,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentRun,
  AgentView,
  Artifact,
  BootstrapData,
  KnowledgeItem,
  Message,
  RunActivity,
  Task,
  TaskProcessData,
  Thread,
  ThreadData,
  ThreadStreamEvent,
  ToolCall,
  Workspace,
} from "../shared/contracts.js";
import { extractMentionHandles, handleFromName } from "../shared/contracts.js";
import { api } from "./api.js";

const RichMessage = lazy(() => import("./RichMessage.js"));

type PrimaryView = "threads" | "surfaces";
type Surface = "taskboard" | "agents" | "knowledge";
type ModalName = "workspace" | "thread" | "agent" | "task" | "knowledge" | "settings" | null;

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
  const [runActivities, setRunActivities] = useState<RunActivity[]>([]);
  const [modal, setModal] = useState<ModalName>(null);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [taskStatus, setTaskStatus] = useState<Task["status"]>("todo");
  const [taskToInspect, setTaskToInspect] = useState<Task>();
  const [taskToEdit, setTaskToEdit] = useState<Task>();
  const [taskToDelete, setTaskToDelete] = useState<Task>();
  const [knowledgeToInspect, setKnowledgeToInspect] = useState<KnowledgeItem>();
  const [knowledgeToEdit, setKnowledgeToEdit] = useState<KnowledgeItem>();
  const [knowledgeToDelete, setKnowledgeToDelete] = useState<KnowledgeItem>();
  const [agentToDelete, setAgentToDelete] = useState<AgentView>();
  const deferredRunActivities = useDeferredValue(runActivities);
  const workspaceIdRef = useRef<string | undefined>(
    window.localStorage.getItem("nexestra.workspaceId") ?? undefined,
  );

  const navigate = useCallback((nextPath: string, nextRoute: RouteState, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextPath);
    setRoute(nextRoute);
  }, []);

  const refresh = useCallback(async (quiet = false, workspaceId = workspaceIdRef.current) => {
    try {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
      const next = await api<BootstrapData>(`/api/bootstrap${query}`);
      workspaceIdRef.current = next.workspace.id;
      window.localStorage.setItem("nexestra.workspaceId", next.workspace.id);
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
      return next;
    } catch (caught) {
      if (!quiet) setError(messageFrom(caught));
      return undefined;
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

  const routeThreadExists = Boolean(
    route.threadId && data?.threads.some((thread) => thread.id === route.threadId),
  );
  useEffect(() => {
    if (route.view !== "threads") return;
    const threadId = routeThreadExists ? route.threadId : data?.threads[0]?.id;
    if (!threadId) return;
    if (threadId !== route.threadId) {
      navigate(`/threads/${threadId}`, { view: "threads", surface: route.surface, threadId }, true);
    }
  }, [data?.threads, navigate, route, routeThreadExists]);

  useEffect(() => {
    if (route.view !== "threads" || !route.threadId || !routeThreadExists) return;
    setRunActivities([]);
    void loadThread(route.threadId);
  }, [loadThread, route.threadId, route.view, routeThreadExists]);

  const hasActiveThreadRuns = threadData?.runs.some(
    (run) =>
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "waiting_approval" ||
      run.status === "waiting_input",
  );
  const isWatchingActiveThread = Boolean(
    hasActiveThreadRuns &&
      route.view === "threads" &&
      route.threadId &&
      route.threadId === threadData?.thread.id,
  );
  const supportsThreadStreaming = typeof window.EventSource === "function";
  const isPollingActiveThread = isWatchingActiveThread && !supportsThreadStreaming;
  const isLoadingCurrentThread = Boolean(
    route.view === "threads" && route.threadId && route.threadId !== threadData?.thread.id,
  );
  useEffect(() => {
    if (!isPollingActiveThread || !route.threadId) return;
    const threadId = route.threadId;
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) return;
      requestInFlight = true;
      void loadThread(threadId, true)
        .then((next) => {
          const stillActive = next?.runs.some(
            (run) =>
              run.status === "queued" ||
              run.status === "running" ||
              run.status === "waiting_approval" ||
              run.status === "waiting_input",
          );
          if (next && !stillActive) void refresh(true);
        })
        .finally(() => {
          requestInFlight = false;
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isPollingActiveThread, loadThread, refresh, route.threadId]);

  useEffect(() => {
    if (!isWatchingActiveThread || !supportsThreadStreaming || !route.threadId) return;
    const threadId = route.threadId;
    const source = new window.EventSource(`/api/threads/${encodeURIComponent(threadId)}/events`);
    let requestInFlight = false;
    let refreshQueued = false;
    const reload = () => {
      if (requestInFlight) {
        refreshQueued = true;
        return;
      }
      requestInFlight = true;
      void loadThread(threadId, true)
        .then((next) => {
          const stillActive = next?.runs.some(
            (run) =>
              run.status === "queued" ||
              run.status === "running" ||
              run.status === "waiting_approval" ||
              run.status === "waiting_input",
          );
          if (next && !stillActive) void refresh(true);
        })
        .finally(() => {
          requestInFlight = false;
          if (refreshQueued) {
            refreshQueued = false;
            reload();
          }
        });
    };
    const onThreadEvent = (raw: Event) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as ThreadStreamEvent;
        setRunActivities(event.activities);
        if (event.refresh) reload();
      } catch {
        // EventSource reconnects automatically; a malformed event must not break the thread.
      }
    };
    source.addEventListener("thread", onThreadEvent);
    return () => {
      source.removeEventListener("thread", onThreadEvent);
      source.close();
    };
  }, [isWatchingActiveThread, loadThread, refresh, route.threadId, supportsThreadStreaming]);

  const hasBackgroundRuns =
    Boolean(data?.activeRuns.length) && !isWatchingActiveThread && !isLoadingCurrentThread;
  useEffect(() => {
    if (!hasBackgroundRuns || !data) return;
    const workspaceId = data.workspace.id;
    let requestInFlight = false;
    const timer = window.setInterval(() => {
      if (requestInFlight) return;
      requestInFlight = true;
      void api<{ activeRuns: AgentRun[] }>(
        `/api/activity?workspaceId=${encodeURIComponent(workspaceId)}`,
      )
        .then((activity) => {
          if (activity.activeRuns.length === 0) void refresh(true, workspaceId);
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false;
        });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [data, hasBackgroundRuns, refresh]);

  const openThread = (threadId: string) =>
    navigate(`/threads/${threadId}`, { view: "threads", surface: route.surface, threadId });
  const openSurface = (surface: Surface) =>
    navigate(`/surfaces/${surface}`, { view: "surfaces", surface });

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === data?.workspace.id) return;
    setThreadData(undefined);
    const next = await refresh(false, workspaceId);
    if (!next) return;
    if (route.view === "threads") {
      const threadId = next.threads[0]?.id;
      if (threadId) {
        navigate(`/threads/${threadId}`, { ...route, view: "threads", threadId });
      }
    }
  };

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
        <p>{error ?? "Opening workspace…"}</p>
        {error && (
          <button type="button" onClick={() => void refresh()}>
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <main className="app-shell">
      <TopBar
        key={`${data.workspace.id}:${route.view}:${route.threadId ?? route.surface}`}
        data={data}
        onThread={openThread}
        onSurface={openSurface}
        onSettings={() => setModal("settings")}
      />
      <WorkspaceRail
        workspaces={data.workspaces}
        activeWorkspaceId={data.workspace.id}
        onWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
        onCreate={() => setModal("workspace")}
      />
      <Sidebar
        data={data}
        route={route}
        onThread={openThread}
        onSurface={openSurface}
        onThreads={() => {
          const threadId = route.threadId ?? data.threads[0]?.id;
          if (threadId) openThread(threadId);
        }}
        onSettings={() => setModal("settings")}
        onCreate={() => {
          if (route.view === "threads") setModal("thread");
          else if (route.surface === "agents") setModal("agent");
          else if (route.surface === "taskboard") {
            setTaskStatus("todo");
            setModal("task");
          } else setModal("knowledge");
        }}
      />
      <section className="workspace">
        {route.view === "threads" ? (
          <ThreadView
            key={route.threadId}
            data={data}
            threadData={threadData}
            runActivities={deferredRunActivities}
            onSend={async (content, files) => {
              if (!route.threadId) return;
              const body = new FormData();
              body.append("content", content);
              for (const file of files) body.append("files", file);
              await api(
                `/api/threads/${route.threadId}/messages`,
                files.length > 0
                  ? { method: "POST", body }
                  : { method: "POST", body: JSON.stringify({ content }) },
              );
              await Promise.all([refresh(true), loadThread(route.threadId)]);
            }}
            onRetry={(runId) =>
              mutate(
                () => api(`/api/runs/${runId}/retry`, { method: "POST", body: "{}" }),
                "Reply queued again.",
              )
            }
            onToolDecision={async (toolCallId, approved) => {
              await api(`/api/tool-calls/${toolCallId}/${approved ? "approve" : "deny"}`, {
                method: "POST",
                body: "{}",
              });
              if (route.threadId) await loadThread(route.threadId, true);
            }}
            onToolResponse={async (toolCallId, answers) => {
              await api(`/api/tool-calls/${toolCallId}/respond`, {
                method: "POST",
                body: JSON.stringify({ answers }),
              });
              if (route.threadId) await loadThread(route.threadId, true);
            }}
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
                agent.enabled ? `Disabled @${agent.handle}.` : `Enabled @${agent.handle}.`,
              )
            }
            onArchive={(agent) =>
              mutate(
                () =>
                  api(`/api/agents/${agent.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ archived: true }),
                  }),
                `Archived @${agent.handle}.`,
              )
            }
            onDelete={setAgentToDelete}
          />
        ) : route.surface === "knowledge" ? (
          <KnowledgeView
            data={data}
            onCreate={() => setModal("knowledge")}
            onInspect={setKnowledgeToInspect}
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
                "Task updated.",
              )
            }
            onThread={openThread}
            onInspect={setTaskToInspect}
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
                body: JSON.stringify({ workspaceId: data.workspace.id, name }),
              });
              await refresh();
              setModal(null);
              openThread(thread.id);
              flash("Thread created.");
            } catch (caught) {
              setError(messageFrom(caught));
              throw caught;
            }
          }}
        />
      )}
      {modal === "workspace" && (
        <WorkspaceDialog
          onClose={() => setModal(null)}
          onCreate={async (name) => {
            try {
              const workspace = await api<Workspace>("/api/workspaces", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              const next = await refresh(false, workspace.id);
              setModal(null);
              const threadId = next?.threads[0]?.id;
              if (threadId) {
                navigate(`/threads/${threadId}`, {
                  view: "threads",
                  surface: route.surface,
                  threadId,
                });
              }
              flash(`Workspace ${workspace.name} created.`);
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
            flash("Agent created. Its runtime status is shown in the directory.");
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
            flash("Task added to the board.");
          }}
        />
      )}
      {taskToInspect && (
        <TaskProcessDialog
          task={taskToInspect}
          data={data}
          onClose={() => {
            setTaskToInspect(undefined);
            void refresh(true);
          }}
          onThread={(threadId) => {
            setTaskToInspect(undefined);
            openThread(threadId);
          }}
          onEdit={(task) => {
            setTaskToInspect(undefined);
            setTaskToEdit(task);
          }}
          onDelete={(task) => {
            setTaskToInspect(undefined);
            setTaskToDelete(task);
          }}
        />
      )}
      {taskToEdit && (
        <TaskDialog
          data={data}
          task={taskToEdit}
          initialStatus={taskToEdit.status}
          onClose={() => setTaskToEdit(undefined)}
          onCreated={async () => {
            await refresh();
            setTaskToEdit(undefined);
            flash("Task updated.");
          }}
        />
      )}
      {taskToDelete && (
        <DeleteTaskDialog
          task={taskToDelete}
          onClose={() => setTaskToDelete(undefined)}
          onDeleted={async () => {
            await refresh();
            setTaskToDelete(undefined);
            flash("Task deleted.");
          }}
        />
      )}
      {modal === "knowledge" && (
        <KnowledgeDialog
          data={data}
          onClose={() => setModal(null)}
          onCreated={async () => {
            await refresh();
            setModal(null);
            flash("Knowledge added to the workspace.");
          }}
        />
      )}
      {knowledgeToInspect && (
        <KnowledgeDetailDialog
          item={knowledgeToInspect}
          onClose={() => setKnowledgeToInspect(undefined)}
          onEdit={(item) => {
            setKnowledgeToInspect(undefined);
            setKnowledgeToEdit(item);
          }}
          onDelete={(item) => {
            setKnowledgeToInspect(undefined);
            setKnowledgeToDelete(item);
          }}
        />
      )}
      {knowledgeToEdit && (
        <EditKnowledgeDialog
          item={knowledgeToEdit}
          onClose={() => setKnowledgeToEdit(undefined)}
          onSaved={async () => {
            await refresh();
            setKnowledgeToEdit(undefined);
            flash("Knowledge updated.");
          }}
        />
      )}
      {knowledgeToDelete && (
        <DeleteKnowledgeDialog
          item={knowledgeToDelete}
          hasAssignmentHistory={data.assignments.some(
            (assignment) => assignment.repositoryId === knowledgeToDelete.id,
          )}
          onClose={() => setKnowledgeToDelete(undefined)}
          onDeleted={async () => {
            await refresh();
            setKnowledgeToDelete(undefined);
            flash("Knowledge deleted.");
          }}
        />
      )}
      {modal === "settings" && <SettingsDialog data={data} onClose={() => setModal(null)} />}
      {agentToDelete && (
        <DeleteAgentDialog
          agent={agentToDelete}
          onClose={() => setAgentToDelete(undefined)}
          onDeleted={async () => {
            setData((current) =>
              current
                ? {
                    ...current,
                    agents: current.agents.filter((agent) => agent.id !== agentToDelete.id),
                    tasks: current.tasks.map((task) =>
                      task.assigneeId === agentToDelete.id ? { ...task, assigneeId: null } : task,
                    ),
                  }
                : current,
            );
            setAgentToDelete(undefined);
            flash(`Deleted @${agentToDelete.handle}.`);
            window.setTimeout(() => {
              document.querySelector<HTMLButtonElement>("[data-create-agent]")?.focus();
            }, 0);
            await refresh(true);
            if (route.threadId) await loadThread(route.threadId, true);
          }}
        />
      )}
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
          <button type="button" onClick={() => setError(undefined)} aria-label="Close">
            <X size={15} />
          </button>
        </div>
      )}
    </main>
  );
}

function TopBar(props: {
  data: BootstrapData;
  onThread: (id: string) => void;
  onSurface: (surface: Surface) => void;
  onSettings: () => void;
}) {
  const [queryText, setQueryText] = useState("");
  const deferredQueryText = useDeferredValue(queryText);
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
  const query = deferredQueryText.trim().toLowerCase();
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
        ...props.data.knowledge
          .filter((item) => `${item.name} ${item.handle}`.toLowerCase().includes(query))
          .map((item) => ({
            id: item.id,
            label: `#${item.handle}`,
            type: item.kind === "document" ? "Document" : "Repository",
            action: () => props.onSurface("knowledge" as const),
          })),
      ].slice(0, 8)
    : [];
  return (
    <header className="topbar">
      <div className="global-search">
        <Search size={16} />
        <input
          ref={searchRef}
          aria-label="Search threads, tasks, agents, or knowledge"
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          placeholder="Search threads, tasks, agents, or knowledge"
        />
        <kbd>⌘/Ctrl K</kbd>
        {query && (
          <div className="search-results">
            {results.length === 0 ? (
              <p>No results found.</p>
            ) : (
              results.map((result) => (
                <button
                  type="button"
                  key={`${result.type}-${result.id}`}
                  onClick={() => {
                    result.action();
                    setQueryText("");
                  }}
                >
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
        aria-label="Open settings"
        onClick={props.onSettings}
      >
        ME
        <span />
      </button>
    </header>
  );
}

function WorkspaceRail(props: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onWorkspace: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <nav className="app-rail" aria-label="Workspaces">
      <div className="workspace-switcher">
        {props.workspaces.map((workspace) => (
          <button
            className={
              workspace.id === props.activeWorkspaceId
                ? "workspace-button active"
                : "workspace-button"
            }
            type="button"
            key={workspace.id}
            onClick={() => props.onWorkspace(workspace.id)}
            aria-label={`Switch to ${workspace.name}`}
            aria-current={workspace.id === props.activeWorkspaceId ? "page" : undefined}
            title={workspace.name}
          >
            {workspaceInitials(workspace.name)}
          </button>
        ))}
      </div>
      <button
        className="workspace-button workspace-add"
        type="button"
        onClick={props.onCreate}
        aria-label="Create workspace"
        title="Create workspace"
      >
        <Plus size={20} />
      </button>
    </nav>
  );
}

function Sidebar(props: {
  data: BootstrapData;
  route: RouteState;
  onThread: (id: string) => void;
  onSurface: (surface: Surface) => void;
  onThreads: () => void;
  onSettings: () => void;
  onCreate: () => void;
}) {
  const visibleAgents = props.data.agents.filter((agent) => !agent.archived);
  return (
    <aside className="sidebar">
      <div className="workspace-title">
        <div title={props.data.workspace.name}>{props.data.workspace.name}</div>
        <button
          className="icon-button"
          type="button"
          onClick={props.onCreate}
          aria-label="Create new"
        >
          <Plus size={18} />
        </button>
      </div>
      <nav className="primary-navigation" aria-label="Workspace navigation">
        <button
          className={
            props.route.view === "threads" ? "primary-nav-item active" : "primary-nav-item"
          }
          type="button"
          onClick={props.onThreads}
        >
          <MessageSquareMore size={17} />
          Threads
        </button>
        <button
          className={
            props.route.view === "surfaces" ? "primary-nav-item active" : "primary-nav-item"
          }
          type="button"
          onClick={() => props.onSurface(props.route.surface)}
        >
          <Sparkles size={17} />
          Surfaces
        </button>
      </nav>
      <div className="sidebar-content">
        {props.route.view === "threads" ? (
          <>
            <div className="sidebar-hint">
              <MessageSquareMore size={14} />
              <span>Shared conversations</span>
            </div>
            <div className="section-label">
              <span>Threads</span>
              <button type="button" onClick={props.onCreate} aria-label="Create thread">
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
                Create your first agent →
              </button>
            )}
          </>
        ) : (
          <>
            <p className="sidebar-kicker">Workspace</p>
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
                className={
                  props.route.surface === "knowledge" ? "sidebar-row selected" : "sidebar-row"
                }
                type="button"
                onClick={() => props.onSurface("knowledge")}
              >
                <BookOpen size={17} />
                <span className="row-label">Knowledge</span>
                <span className="count">{props.data.knowledge.length}</span>
              </button>
              <button
                className={
                  props.route.surface === "agents" ? "sidebar-row selected" : "sidebar-row"
                }
                type="button"
                onClick={() => props.onSurface("agents")}
              >
                <UsersRound size={17} />
                <span className="row-label">Agent management</span>
                <span className="count">{visibleAgents.length}</span>
              </button>
            </div>
          </>
        )}
      </div>
      <button className="sidebar-settings" type="button" onClick={props.onSettings}>
        <Settings size={17} />
        Settings
      </button>
    </aside>
  );
}

function ThreadView(props: {
  data: BootstrapData;
  threadData?: ThreadData;
  runActivities: RunActivity[];
  onSend: (content: string, files: File[]) => Promise<void>;
  onRetry: (runId: string) => Promise<unknown>;
  onToolDecision: (toolCallId: string, approved: boolean) => Promise<void>;
  onToolResponse: (toolCallId: string, answers: string[][]) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [mentionMenuOpen, setMentionMenuOpen] = useState(true);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [activeTab, setActiveTab] = useState<"messages" | "artifacts">("messages");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionAgents = useMemo(
    () =>
      props.data.agents
        .filter((agent) => agent.enabled && !agent.archived)
        .sort((left, right) => Number(canCallAgent(right)) - Number(canCallAgent(left))),
    [props.data.agents],
  );
  const mentionMatch = draft.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
  const mentionQuery = mentionMatch?.[2]?.toLowerCase();
  const suggestions = mentionMatch
    ? mentionAgents
        .filter((agent) => !mentionQuery || agent.handle.includes(mentionQuery))
        .slice(0, 6)
    : [];
  const knowledgeMatch = mentionMatch ? null : draft.match(/(^|\s)#([a-zA-Z0-9_-]*)$/);
  const knowledgeQuery = knowledgeMatch?.[2]?.toLowerCase();
  const knowledgeSuggestions = knowledgeMatch
    ? props.data.knowledge
        .filter((item) => !knowledgeQuery || item.handle.includes(knowledgeQuery))
        .slice(0, 6)
    : [];
  const suggestionMode = knowledgeMatch ? "knowledge" : mentionMatch ? "agent" : null;
  const activeAgent = suggestions[activeSuggestion];
  const selectedSuggestionIndex =
    suggestionMode === "knowledge"
      ? Math.min(activeSuggestion, Math.max(knowledgeSuggestions.length - 1, 0))
      : activeAgent && canCallAgent(activeAgent)
        ? activeSuggestion
        : suggestions.findIndex(canCallAgent);

  const send = async () => {
    const content = draft.trim();
    if ((!content && attachments.length === 0) || sending) return;
    const agentsByHandle = new Map(props.data.agents.map((agent) => [agent.handle, agent]));
    const requestedHandles = extractMentionHandles(content);
    const unavailable = requestedHandles
      .map((handle) => agentsByHandle.get(handle))
      .find((agent) => agent && !canCallAgent(agent));
    if (unavailable) {
      setLocalError(`@${unavailable.handle} cannot be invoked: ${unavailable.readinessLabel}.`);
      return;
    }
    setSending(true);
    setLocalError(undefined);
    try {
      await props.onSend(content, attachments);
      setDraft("");
      setAttachments([]);
      setMentionMenuOpen(true);
    } catch (caught) {
      setLocalError(messageFrom(caught));
    } finally {
      setSending(false);
    }
  };

  const addAttachments = (files: File[]) => {
    const next = [...attachments, ...files];
    if (next.length > 10) {
      setLocalError("Attach no more than 10 files at once.");
      return;
    }
    if (next.some((file) => file.size > 20 * 1024 * 1024)) {
      setLocalError("Each attachment must be 20 MB or smaller.");
      return;
    }
    if (next.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
      setLocalError("Attachments must be 50 MB or smaller in total.");
      return;
    }
    setAttachments(next);
    setLocalError(undefined);
  };

  const pickMention = (agent: AgentView) => {
    if (!canCallAgent(agent) || !mentionMatch || mentionMatch.index === undefined) return;
    const prefixLength = mentionMatch[1]?.length ?? 0;
    const start = mentionMatch.index + prefixLength;
    setDraft(`${draft.slice(0, start)}@${agent.handle} `);
    setMentionMenuOpen(false);
  };

  const pickKnowledge = (item: KnowledgeItem) => {
    if (!knowledgeMatch || knowledgeMatch.index === undefined) return;
    const prefixLength = knowledgeMatch[1]?.length ?? 0;
    const start = knowledgeMatch.index + prefixLength;
    setDraft(`${draft.slice(0, start)}#${item.handle} `);
    setMentionMenuOpen(false);
  };

  const moveSuggestion = (direction: 1 | -1) => {
    if (suggestionMode === "knowledge") {
      if (knowledgeSuggestions.length === 0) return;
      setActiveSuggestion(
        (selectedSuggestionIndex + direction + knowledgeSuggestions.length) %
          knowledgeSuggestions.length,
      );
      return;
    }
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
    const menuVisible =
      mentionMenuOpen &&
      (suggestionMode === "knowledge" ? knowledgeSuggestions.length > 0 : suggestions.length > 0);
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
    const selectedKnowledge = knowledgeSuggestions[selectedSuggestionIndex];
    if (
      menuVisible &&
      suggestionMode === "knowledge" &&
      selectedKnowledge &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
    ) {
      event.preventDefault();
      pickKnowledge(selectedKnowledge);
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
  if (!thread || !props.threadData) {
    return (
      <div className="surface-loading">
        <LoaderCircle className="spin" size={20} /> Loading transcript…
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
          Shared transcript
        </div>
      </header>
      <div className="thread-tabs">
        <button
          type="button"
          className={activeTab === "messages" ? "active" : ""}
          onClick={() => setActiveTab("messages")}
        >
          <MessageSquareMore size={15} /> Messages
        </button>
        <button
          type="button"
          className={activeTab === "artifacts" ? "active" : ""}
          onClick={() => setActiveTab("artifacts")}
        >
          <Paperclip size={15} /> Files &amp; links
          {props.threadData.artifacts.length > 0 && (
            <em className="thread-tab-count">{props.threadData.artifacts.length}</em>
          )}
        </button>
      </div>
      {activeTab === "messages" ? (
        <ThreadTranscript
          thread={thread}
          messages={props.threadData.messages}
          artifacts={props.threadData.artifacts}
          runs={props.threadData.runs}
          toolCalls={props.threadData.toolCalls ?? []}
          runActivities={props.runActivities}
          agents={props.data.agents}
          knowledge={props.data.knowledge}
          onRetry={props.onRetry}
          onToolDecision={props.onToolDecision}
          onToolResponse={props.onToolResponse}
        />
      ) : (
        <ThreadArtifacts
          thread={thread}
          artifacts={props.threadData.artifacts}
          messages={props.threadData.messages}
        />
      )}
      {activeTab === "messages" && (
        <div className="composer-wrap">
          {mentionMenuOpen &&
            (suggestionMode === "knowledge"
              ? knowledgeSuggestions.length > 0
              : suggestions.length > 0) && (
              <div
                className="mention-menu"
                id="mention-suggestions"
                role="listbox"
                aria-label={suggestionMode === "knowledge" ? "Choose knowledge" : "Choose an agent"}
              >
                <p>{suggestionMode === "knowledge" ? "Reference knowledge" : "Mention an agent"}</p>
                {suggestionMode === "knowledge"
                  ? knowledgeSuggestions.map((item, index) => (
                      <button
                        type="button"
                        role="option"
                        id={`mention-option-${item.id}`}
                        aria-selected={index === selectedSuggestionIndex}
                        className={index === selectedSuggestionIndex ? "active" : ""}
                        key={item.id}
                        onClick={() => pickKnowledge(item)}
                        onMouseEnter={() => setActiveSuggestion(index)}
                      >
                        <span className="reference-suggestion-icon">
                          {item.kind === "document" ? (
                            <FileText size={15} />
                          ) : (
                            <GitBranch size={15} />
                          )}
                        </span>
                        <span>
                          <strong>#{item.handle}</strong>
                          <small>{item.name}</small>
                        </span>
                        <em>{item.kind === "document" ? "Document" : item.status}</em>
                      </button>
                    ))
                  : suggestions.map((agent, index) => (
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
                          <small>
                            {agent.kind === "master" ? "Master" : `${agent.harness} worker`}
                          </small>
                        </span>
                        <em>{agent.readinessLabel}</em>
                      </button>
                    ))}
              </div>
            )}
          <fieldset
            className={`composer${draggingFiles ? " dragging" : ""}`}
            aria-label="Message composer"
            onDragEnter={(event) => {
              event.preventDefault();
              setDraggingFiles(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDraggingFiles(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDraggingFiles(false);
              addAttachments([...event.dataTransfer.files]);
            }}
          >
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              aria-label="Choose files or images"
              onChange={(event) => {
                addAttachments([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            {attachments.length > 0 && (
              <ul className="pending-attachments" aria-label="Attachments ready to send">
                {attachments.map((file, index) => (
                  <li key={`${file.name}:${file.size}:${file.lastModified}:${file.type}`}>
                    {file.type.startsWith("image/") ? (
                      <ImageIcon size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                    <b>{file.name}</b>
                    <small>{formatBytes(file.size)}</small>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setAttachments((current) => current.filter((_, item) => item !== index))
                      }
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              aria-label="Message"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={
                mentionMenuOpen &&
                (suggestionMode === "knowledge"
                  ? knowledgeSuggestions.length > 0
                  : suggestions.length > 0)
              }
              aria-controls="mention-suggestions"
              aria-activedescendant={
                mentionMenuOpen &&
                (suggestionMode === "knowledge"
                  ? knowledgeSuggestions[selectedSuggestionIndex]
                  : suggestions[selectedSuggestionIndex])
                  ? `mention-option-${
                      suggestionMode === "knowledge"
                        ? knowledgeSuggestions[selectedSuggestionIndex]?.id
                        : suggestions[selectedSuggestionIndex]?.id
                    }`
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
              placeholder={`Message #${thread.slug} — use @ for agents or # for knowledge`}
              rows={2}
            />
            <div className="composer-toolbar">
              <div>
                <button
                  className="attachment-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach files or images"
                >
                  <Paperclip size={16} />
                </button>
                <button
                  className="mention-button"
                  type="button"
                  onClick={() => {
                    setMentionMenuOpen(true);
                    setActiveSuggestion(0);
                    setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}@`);
                  }}
                  aria-label="Mention an agent"
                >
                  @
                </button>
                <button
                  className="mention-button"
                  type="button"
                  onClick={() => {
                    setMentionMenuOpen(true);
                    setActiveSuggestion(0);
                    setDraft((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}#`);
                  }}
                  aria-label="Reference knowledge"
                >
                  #
                </button>
                <span>@ invokes an agent · # shares workspace knowledge</span>
              </div>
              <button
                className="send-button"
                type="button"
                onClick={() => void send()}
                disabled={(!draft.trim() && attachments.length === 0) || sending}
                aria-label="Send"
              >
                {sending ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <SendHorizontal size={17} />
                )}
              </button>
            </div>
          </fieldset>
          <p>
            <kbd>Enter</kbd> to send · <kbd>Shift Enter</kbd> for a new line
          </p>
          {localError && (
            <p className="inline-error">
              <CircleAlert size={13} />
              {localError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const ThreadTranscript = memo(function ThreadTranscript({
  thread,
  messages,
  artifacts,
  runs,
  toolCalls,
  runActivities,
  agents,
  knowledge,
  onRetry,
  onToolDecision,
  onToolResponse,
}: {
  thread: Thread;
  messages: Message[];
  artifacts: Artifact[];
  runs: AgentRun[];
  toolCalls: ToolCall[];
  runActivities: RunActivity[];
  agents: AgentView[];
  knowledge: KnowledgeItem[];
  onRetry: (runId: string) => Promise<unknown>;
  onToolDecision: (toolCallId: string, approved: boolean) => Promise<void>;
  onToolResponse: (toolCallId: string, answers: string[][]) => Promise<void>;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const currentAgentHandles = useMemo(() => agents.map((agent) => agent.handle), [agents]);
  const knownAgentHandles = useMemo(() => new Set(currentAgentHandles), [currentAgentHandles]);
  const knownKnowledgeHandles = useMemo(
    () => new Set(knowledge.map((item) => item.handle)),
    [knowledge],
  );
  const artifactsByMessage = useMemo(() => {
    const grouped = new Map<string, Artifact[]>();
    for (const artifact of artifacts) {
      const messageArtifacts = grouped.get(artifact.messageId) ?? [];
      messageArtifacts.push(artifact);
      grouped.set(artifact.messageId, messageArtifacts);
    }
    return grouped;
  }, [artifacts]);
  const runsByTrigger = useMemo(() => {
    const grouped = new Map<string, AgentRun[]>();
    for (const run of latestAttempts(runs)) {
      const triggerRuns = grouped.get(run.triggerMessageId) ?? [];
      triggerRuns.push(run);
      grouped.set(run.triggerMessageId, triggerRuns);
    }
    return grouped;
  }, [runs]);
  const toolCallsByRun = useMemo(() => {
    const grouped = new Map<string, ToolCall[]>();
    for (const toolCall of toolCalls) {
      const runTools = grouped.get(toolCall.runId) ?? [];
      runTools.push(toolCall);
      grouped.set(toolCall.runId, runTools);
    }
    return grouped;
  }, [toolCalls]);
  const activitiesByRun = useMemo(
    () => new Map(runActivities.map((activity) => [activity.runId, activity])),
    [runActivities],
  );
  const transcriptVersion = `${messages.length}:${artifacts.length}:${runs
    .map((run) => `${run.id}-${run.status}`)
    .join(",")}:${toolCalls.map((call) => `${call.id}-${call.status}`).join(",")}:${runActivities
    .map(
      (activity) =>
        `${activity.runId}-${activity.updatedAt}-${activity.thinking.length}-${activity.text.length}`,
    )
    .join(",")}`;
  useEffect(() => {
    if (!transcriptVersion) return;
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [transcriptVersion]);

  return (
    <div className="message-scroll">
      <div className="thread-intro">
        <span className="channel-badge">#</span>
        <h2>{thread.name}</h2>
        <p>
          People and agents share one transcript. Send a regular message to leave a note; add{" "}
          <mark>@agent</mark> when you want an agent to reply.
        </p>
      </div>
      {messages.length > 0 && (
        <div className="date-divider">
          <span>Today</span>
        </div>
      )}
      {messages.map((message) => (
        <div key={message.id}>
          <MessageRow
            message={message}
            artifacts={artifactsByMessage.get(message.id) ?? []}
            knownHandles={
              new Set([
                ...currentAgentHandles,
                ...message.mentions.map((mention) => mention.handle),
                ...(message.author.kind === "agent" ? [message.author.handle] : []),
              ])
            }
            knownKnowledgeHandles={knownKnowledgeHandles}
            agent={message.author.kind === "agent" ? agentsById.get(message.author.id) : undefined}
          />
          {(runsByTrigger.get(message.id) ?? []).map((run) => (
            <RunRow
              key={run.id}
              run={run}
              agent={agentsById.get(run.agentId)}
              historicalHandle={
                message.mentions.find((mention) => mention.agentId === run.agentId)?.handle
              }
              onRetry={onRetry}
              toolCalls={toolCallsByRun.get(run.id) ?? []}
              activity={activitiesByRun.get(run.id)}
              knownHandles={knownAgentHandles}
              onToolDecision={onToolDecision}
              onToolResponse={onToolResponse}
            />
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
});

function MessageRow({
  message,
  artifacts,
  agent,
  knownHandles,
  knownKnowledgeHandles,
}: {
  message: Message;
  artifacts: Artifact[];
  agent?: AgentView;
  knownHandles: ReadonlySet<string>;
  knownKnowledgeHandles: ReadonlySet<string>;
}) {
  const agentAuthor = message.author.kind === "agent" ? message.author : undefined;
  return (
    <article className="message">
      {agentAuthor ? (
        agent ? (
          <Avatar agent={agent} />
        ) : (
          <HistoricalAgentAvatar name={agentAuthor.name} handle={agentAuthor.handle} />
        )
      ) : (
        <span className="avatar avatar-purple">ME</span>
      )}
      <div>
        <div className="message-meta">
          <strong>{message.author.name}</strong>
          {agentAuthor && (
            <span className="agent-badge">
              {agent ? (agent.kind === "master" ? "MASTER" : "WORKER") : "AGENT"}
            </span>
          )}
          <time>{formatTime(message.createdAt)}</time>
        </div>
        {message.content && (
          <Suspense fallback={<p className="message-markdown-fallback">{message.content}</p>}>
            <RichMessage
              content={message.content}
              knownHandles={knownHandles}
              knownKnowledgeHandles={knownKnowledgeHandles}
            />
          </Suspense>
        )}
        {artifacts.length > 0 && <MessageArtifacts artifacts={artifacts} />}
      </div>
    </article>
  );
}

function MessageArtifacts({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <div className="message-artifacts">
      {artifacts.map((artifact) => {
        if (artifact.kind === "image") {
          const href = artifactContentUrl(artifact);
          return (
            <a
              className="message-image"
              href={href}
              target="_blank"
              rel="noreferrer"
              key={artifact.id}
              aria-label={`Open ${artifact.name}`}
            >
              <img src={href} alt={artifact.name} loading="lazy" />
              <span>{artifact.name}</span>
            </a>
          );
        }
        const href = artifact.url ?? artifactContentUrl(artifact);
        return (
          <a
            className="message-file"
            href={href}
            target="_blank"
            rel="noreferrer"
            key={artifact.id}
          >
            {artifact.kind === "link" ? <LinkIcon size={16} /> : <FileText size={16} />}
            <span>
              <strong>{artifact.name}</strong>
              <small>
                {artifact.kind === "link"
                  ? safeHostname(artifact.url)
                  : artifact.size === undefined
                    ? "File"
                    : formatBytes(artifact.size)}
              </small>
            </span>
            <ExternalLink size={14} />
          </a>
        );
      })}
    </div>
  );
}

function ThreadArtifacts({
  thread,
  artifacts,
  messages,
}: {
  thread: Thread;
  artifacts: Artifact[];
  messages: Message[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "files" | "media" | "links">("all");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const visible = useMemo(
    () =>
      artifacts
        .filter((artifact) => {
          if (filter === "files" && artifact.kind !== "file") return false;
          if (filter === "media" && artifact.kind !== "image") return false;
          if (filter === "links" && artifact.kind !== "link") return false;
          if (!deferredQuery) return true;
          return [artifact.name, artifact.url, artifact.path, artifact.mediaType]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(deferredQuery));
        })
        .sort((left, right) => right.sequence - left.sequence),
    [artifacts, deferredQuery, filter],
  );
  const images = visible.filter((artifact) => artifact.kind === "image");
  const rows = visible.filter((artifact) => artifact.kind !== "image");

  return (
    <section className="artifacts-view" aria-label={`Files and links in ${thread.name}`}>
      <label className="artifact-search">
        <Search size={18} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files and links"
          aria-label="Search files and links"
        />
      </label>
      <fieldset className="artifact-filters" aria-label="Artifact type">
        {(["all", "files", "media", "links"] as const).map((value) => (
          <button
            type="button"
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            key={value}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
        <span>Newest first</span>
      </fieldset>
      {visible.length === 0 ? (
        <div className="artifact-empty">
          <Paperclip size={24} />
          <strong>
            {artifacts.length === 0 ? "No files or links yet" : "No matching artifacts"}
          </strong>
          <p>
            {artifacts.length === 0
              ? "Attach files in Messages or share a link to collect it here."
              : "Try another search or filter."}
          </p>
        </div>
      ) : (
        <>
          {images.length > 0 && (
            <div className="artifact-media-section">
              <h2>Photos</h2>
              <div className="artifact-media-grid">
                {images.map((artifact) => {
                  const href = artifactContentUrl(artifact);
                  return (
                    <a href={href} target="_blank" rel="noreferrer" key={artifact.id}>
                      <img src={href} alt={artifact.name} loading="lazy" />
                      <span>{artifact.name}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
          {rows.length > 0 && (
            <div className="artifact-list">
              {rows.map((artifact) => {
                const message = messagesById.get(artifact.messageId);
                const href = artifact.url ?? artifactContentUrl(artifact);
                return (
                  <article key={artifact.id}>
                    <span className={`artifact-kind ${artifact.kind}`}>
                      {artifact.kind === "link" ? <LinkIcon size={18} /> : <FileText size={18} />}
                    </span>
                    <div>
                      <a href={href} target="_blank" rel="noreferrer">
                        {artifact.name}
                      </a>
                      <small>
                        {artifact.source === "upload" ? "Shared" : "Referenced"} by{" "}
                        {message?.author.name ?? "Unknown"}
                        {artifact.size !== undefined ? ` · ${formatBytes(artifact.size)}` : ""}
                        {artifact.kind === "link" ? ` · ${safeHostname(artifact.url)}` : ""}
                      </small>
                    </div>
                    <a
                      className="artifact-action"
                      href={
                        artifact.kind === "link"
                          ? href
                          : `${artifactContentUrl(artifact)}?download=1`
                      }
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${artifact.kind === "link" ? "Open" : "Download"} ${artifact.name}`}
                    >
                      {artifact.kind === "link" ? (
                        <ExternalLink size={16} />
                      ) : (
                        <Download size={16} />
                      )}
                    </a>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function artifactContentUrl(artifact: Artifact): string {
  return `/api/threads/${encodeURIComponent(artifact.threadId)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
}

function safeHostname(value?: string): string {
  if (!value) return "Link";
  try {
    return new URL(value).hostname;
  } catch {
    return "Link";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RunRow({
  run,
  agent,
  historicalHandle,
  onRetry,
  toolCalls,
  activity,
  knownHandles,
  onToolDecision,
  onToolResponse,
}: {
  run: AgentRun;
  agent?: AgentView;
  historicalHandle?: string;
  onRetry: (id: string) => Promise<unknown>;
  toolCalls: ToolCall[];
  activity?: RunActivity;
  knownHandles: ReadonlySet<string>;
  onToolDecision: (id: string, approved: boolean) => Promise<void>;
  onToolResponse: (id: string, answers: string[][]) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const handle = agent?.handle ?? historicalHandle;
  const toolActivity = toolCalls.length > 0 && (
    <div className="tool-activity">
      {toolCalls.map((toolCall) => (
        <ToolCallRow
          key={toolCall.id}
          toolCall={toolCall}
          onDecision={onToolDecision}
          onResponse={onToolResponse}
        />
      ))}
    </div>
  );
  if (run.status === "completed") return null;
  if (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_approval" ||
    run.status === "waiting_input"
  ) {
    const detail =
      activity?.detail ||
      (run.status === "queued"
        ? "Waiting in the queue"
        : run.status === "waiting_approval"
          ? "Waiting for tool approval"
          : run.status === "waiting_input"
            ? "Waiting for your answer"
            : "Working with the repository");
    return (
      <>
        {activity?.thinking && (
          <details className="thinking-activity">
            <summary>
              <Sparkles size={14} />
              <span>Thinking</span>
              <small>Click to view</small>
            </summary>
            <div className="thinking-content">
              <Suspense fallback={<p className="message-markdown-fallback">{activity.thinking}</p>}>
                <RichMessage content={activity.thinking} knownHandles={knownHandles} />
              </Suspense>
            </div>
          </details>
        )}
        {toolActivity}
        <div className={activity?.text ? "live-run live-run-with-text" : "live-run"}>
          <div className="live-run-status">
            {agent ? <Avatar agent={agent} small /> : <span className="avatar avatar-blue">A</span>}
            <span>
              <b>{handle ? `@${handle}` : "Deleted agent"}</b> {detail}
            </span>
            <span className="typing-dots" role="status" aria-label="Agent is working">
              <i />
              <i />
              <i />
            </span>
          </div>
          {activity?.text && (
            <div
              className="live-run-response"
              role="log"
              aria-live="polite"
              aria-label="Streaming response"
            >
              <Suspense fallback={<p className="message-markdown-fallback">{activity.text}</p>}>
                <RichMessage content={activity.text} knownHandles={knownHandles} />
              </Suspense>
              <span className="stream-caret" aria-hidden="true" />
            </div>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      {toolActivity}
      <div className="run-error">
        <CircleAlert size={15} />
        <div>
          <strong>{handle ? `@${handle}` : "Deleted agent"} could not reply</strong>
          <p>{run.error ?? "The run was interrupted."}</p>
        </div>
        {agent ? (
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
            {retrying ? "Queueing…" : "Retry"}
          </button>
        ) : (
          <span className="run-unavailable">Agent deleted</span>
        )}
      </div>
    </>
  );
}

function ToolCallRow({
  toolCall,
  onDecision,
  onResponse,
}: {
  toolCall: ToolCall;
  onDecision: (id: string, approved: boolean) => Promise<void>;
  onResponse: (id: string, answers: string[][]) => Promise<void>;
}) {
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string>();
  const [answers, setAnswers] = useState<string[][]>(() =>
    (toolCall.questions ?? []).map(() => []),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    (toolCall.questions ?? []).map(() => ""),
  );
  const decide = async (approved: boolean) => {
    setDeciding(true);
    setDecisionError(undefined);
    try {
      await onDecision(toolCall.id, approved);
    } catch (caught) {
      setDecisionError(messageFrom(caught));
    } finally {
      setDeciding(false);
    }
  };
  const respond = async () => {
    const complete = answers.map((answer, index) => {
      const custom = customAnswers[index]?.trim();
      return custom
        ? toolCall.questions?.[index]?.multiple
          ? [...answer, custom]
          : [custom]
        : answer;
    });
    if (complete.some((answer) => answer.length === 0)) {
      setDecisionError("Answer every question before continuing.");
      return;
    }
    setDeciding(true);
    setDecisionError(undefined);
    try {
      await onResponse(toolCall.id, complete);
    } catch (caught) {
      setDecisionError(messageFrom(caught));
    } finally {
      setDeciding(false);
    }
  };
  return (
    <div className={`tool-call tool-call-${toolCall.status}`}>
      <TerminalSquare size={15} />
      <div>
        <strong>{toolCall.name}</strong>
        <code>{toolCall.input}</code>
        {(toolCall.summary || toolCall.error) && <p>{toolCall.error ?? toolCall.summary}</p>}
        {decisionError && <p>{decisionError}</p>}
      </div>
      <span>{toolCall.status.replace("_", " ")}</span>
      {toolCall.status === "waiting_approval" && (
        <div className="tool-actions">
          <button type="button" disabled={deciding} onClick={() => void decide(false)}>
            Deny
          </button>
          <button
            className="tool-approve"
            type="button"
            disabled={deciding}
            onClick={() => void decide(true)}
          >
            {deciding ? "Saving…" : "Approve"}
          </button>
        </div>
      )}
      {toolCall.status === "waiting_input" && toolCall.questions && (
        <div className="tool-questions">
          {toolCall.questions.map((question, questionIndex) => (
            <fieldset key={`${question.header}-${question.question}`}>
              <legend>{question.header}</legend>
              <p>{question.question}</p>
              {question.options.map((option) => {
                const selected = answers[questionIndex]?.includes(option.label) ?? false;
                return (
                  <label key={option.label}>
                    <input
                      type={question.multiple ? "checkbox" : "radio"}
                      name={`question-${toolCall.id}-${questionIndex}`}
                      checked={selected}
                      onChange={() =>
                        setAnswers((current) =>
                          current.map((answer, index) => {
                            if (index !== questionIndex) return answer;
                            if (!question.multiple) return [option.label];
                            return selected
                              ? answer.filter((value) => value !== option.label)
                              : [...answer, option.label];
                          }),
                        )
                      }
                    />
                    <span>
                      <b>{option.label}</b>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                );
              })}
              <input
                type="text"
                value={customAnswers[questionIndex] ?? ""}
                onChange={(event) =>
                  setCustomAnswers((current) =>
                    current.map((answer, index) =>
                      index === questionIndex ? event.target.value : answer,
                    ),
                  )
                }
                placeholder="Or type a custom answer"
                maxLength={500}
              />
            </fieldset>
          ))}
          <button
            className="tool-approve"
            type="button"
            disabled={deciding}
            onClick={() => void respond()}
          >
            {deciding ? "Sending…" : "Send answer"}
          </button>
        </div>
      )}
    </div>
  );
}

function KnowledgeView({
  data,
  onCreate,
  onInspect,
}: {
  data: BootstrapData;
  onCreate: () => void;
  onInspect: (item: KnowledgeItem) => void;
}) {
  const documents = data.knowledge.filter((item) => item.kind === "document");
  const repositories = data.knowledge.filter((item) => item.kind === "repository");
  return (
    <div className="surface-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SURFACE</p>
          <h1>Knowledge</h1>
          <p className="subtitle">
            Share documents and repositories with people and agents through a #reference.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={17} />
          Add knowledge
        </button>
      </header>
      <div className="stat-strip">
        <div>
          <span>Knowledge items</span>
          <strong>{data.knowledge.length}</strong>
        </div>
        <div>
          <span>Documents</span>
          <strong>{documents.length}</strong>
        </div>
        <div>
          <span>Repositories</span>
          <strong>{repositories.length}</strong>
        </div>
        <div>
          <span>Worker assignments</span>
          <strong className="accent-number">{data.assignments.length}</strong>
        </div>
      </div>
      {data.knowledge.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={25} />}
          title="No shared knowledge yet"
          body="Upload a document or add a Git repository, then reference it in chat with #handle."
          action="Add your first item"
          onAction={onCreate}
        />
      ) : (
        <div className="knowledge-grid">
          {data.knowledge.map((item) => (
            <article
              className={`knowledge-card${item.kind === "document" ? " has-download" : ""}`}
              key={item.id}
            >
              <button
                className="knowledge-card-open"
                type="button"
                aria-label={`View details for ${item.name}`}
                onClick={() => onInspect(item)}
              >
                <span className="knowledge-icon">
                  {item.kind === "document" ? <FileText size={20} /> : <GitBranch size={20} />}
                </span>
                <span className="knowledge-card-body">
                  <span className="knowledge-card-header">
                    <span>
                      <strong className="knowledge-card-title">{item.name}</strong>
                      <mark>#{item.handle}</mark>
                    </span>
                    <span
                      className={`knowledge-status${item.kind === "repository" ? ` ${item.status}` : ""}`}
                    >
                      {item.kind === "document" ? "Document" : item.status}
                    </span>
                  </span>
                  {item.description && <p>{item.description}</p>}
                  {item.kind === "document" ? (
                    <span className="knowledge-meta">
                      <span>{item.fileName}</span>
                      <span>{formatBytes(item.size)}</span>
                    </span>
                  ) : (
                    <span className="knowledge-meta repository-meta">
                      <code>{item.source}</code>
                      {item.defaultBranch && <span>Default branch: {item.defaultBranch}</span>}
                      {item.error && <span className="knowledge-error">{item.error}</span>}
                    </span>
                  )}
                </span>
              </button>
              {item.kind === "document" && (
                <a
                  className="knowledge-card-download"
                  href={`/api/knowledge/${encodeURIComponent(item.id)}/content`}
                  download
                >
                  <Download size={13} /> Download
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentsView(props: {
  data: BootstrapData;
  onCreate: () => void;
  onToggle: (agent: AgentView) => Promise<unknown>;
  onArchive: (agent: AgentView) => Promise<unknown>;
  onDelete: (agent: AgentView) => void;
}) {
  const agents = props.data.agents.filter((agent) => !agent.archived);
  const archivedAgents = props.data.agents.filter((agent) => agent.archived);
  return (
    <div className="surface-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SURFACE</p>
          <h1>Agent management</h1>
          <p className="subtitle">
            Create conversational Masters or Workers backed by coding harnesses.
          </p>
        </div>
        <button className="primary-button" type="button" data-create-agent onClick={props.onCreate}>
          <Plus size={17} />
          Create agent
        </button>
      </header>
      <div className="stat-strip">
        <div>
          <span>Active agents</span>
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
          <span>Responding</span>
          <strong className="accent-number">
            {agents.filter((agent) => agent.readiness === "busy").length}
          </strong>
        </div>
      </div>
      {agents.length === 0 ? (
        <EmptyState
          icon={<Bot size={25} />}
          title={archivedAgents.length > 0 ? "No active agents" : "No agents yet"}
          body="Create a Master or Worker agent, then invoke it with @handle in a thread."
          action="Create your first agent"
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
              onDelete={props.onDelete}
            />
          ))}
        </div>
      )}
      {archivedAgents.length > 0 && (
        <section className="archived-agents">
          <header>
            <div>
              <p className="eyebrow">ARCHIVE</p>
              <h2>Archived agents</h2>
            </div>
            <span>{archivedAgents.length}</span>
          </header>
          <div className="agents-grid">
            {archivedAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onToggle={props.onToggle}
                onArchive={props.onArchive}
                onDelete={props.onDelete}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onToggle,
  onArchive,
  onDelete,
}: {
  agent: AgentView;
  onToggle: (agent: AgentView) => Promise<unknown>;
  onArchive: (agent: AgentView) => Promise<unknown>;
  onDelete: (agent: AgentView) => void;
}) {
  const workerModel = agent.kind === "worker" ? agent.model : undefined;
  const workerReasoningEffort = agent.kind === "worker" ? agent.reasoningEffort : undefined;
  const detail =
    agent.kind === "worker"
      ? [
          `${agent.harness === "codex" ? "Codex" : "OpenCode"} harness`,
          workerModel,
          workerReasoningEffort
            ? `${workerReasoningEffort} ${agent.harness === "codex" ? "reasoning" : "variant"}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : agent.provider.type === "chatgpt"
        ? `ChatGPT OAuth${agent.provider.model ? ` · ${agent.provider.model}` : ""} · ${masterAccessLabel(agent)}`
        : `${agent.provider.name} · ${agent.provider.model} · ${masterAccessLabel(agent)}`;
  return (
    <article className={`agent-card${agent.archived ? " agent-card-archived" : ""}`}>
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
            ? "Master agent reads shared context and responds in the thread."
            : "Worker agent reads the repository and responds through its selected harness.")}
      </p>
      <div className="agent-card-footer">
        <span>
          {agent.archived
            ? "Archived and hidden from mentions"
            : !agent.enabled
              ? "Hidden from the mention picker"
              : canCallAgent(agent)
                ? "Available through @mention"
                : `Setup required: ${agent.readinessLabel}`}
        </span>
        <div>
          {!agent.archived && (
            <>
              <button type="button" onClick={() => void onToggle(agent)}>
                {agent.enabled ? "Disable" : "Enable"}
              </button>
              <button type="button" onClick={() => void onArchive(agent)}>
                <Archive size={12} />
                Archive
              </button>
            </>
          )}
          <button
            type="button"
            className="danger-link"
            aria-label={`Delete @${agent.handle}`}
            onClick={() => onDelete(agent)}
          >
            <Trash2 size={12} />
            Delete
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
  onInspect: (task: Task) => void;
}) {
  const columns: { status: Task["status"]; title: string }[] = [
    { status: "todo", title: "To do" },
    { status: "in_progress", title: "In progress" },
    { status: "done", title: "Done" },
  ];
  const agents = new Map(props.data.agents.map((agent) => [agent.id, agent]));
  const assignments = new Map<string, BootstrapData["assignments"][number]>();
  for (const assignment of props.data.assignments) {
    if (!assignments.has(assignment.taskId)) assignments.set(assignment.taskId, assignment);
  }
  return (
    <div className="surface-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SURFACE</p>
          <h1>Taskboard</h1>
          <p className="subtitle">Organize work here; only an @mention in chat invokes an agent.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => props.onCreate("todo")}>
          <Plus size={17} />
          Create task
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
                  aria-label={`Create a task in ${column.title}`}
                >
                  <Plus size={16} />
                </button>
              </header>
              {tasks.length === 0 && <p className="column-empty">No tasks yet</p>}
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  agent={task.assigneeId ? agents.get(task.assigneeId) : undefined}
                  assignment={assignments.get(task.id)}
                  onMove={props.onMove}
                  onThread={props.onThread}
                  onInspect={props.onInspect}
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
  assignment,
  onMove,
  onThread,
  onInspect,
}: {
  task: Task;
  agent?: AgentView;
  assignment?: BootstrapData["assignments"][number];
  onMove: (task: Task, status: Task["status"]) => Promise<unknown>;
  onThread: (id: string) => void;
  onInspect: (task: Task) => void;
}) {
  const statuses: Task["status"][] = ["todo", "in_progress", "done"];
  const position = statuses.indexOf(task.status);
  const assignmentActive = assignment?.status === "queued" || assignment?.status === "running";
  return (
    <article className={assignmentActive ? "task-card task-card-active" : "task-card"}>
      <button
        className="task-card-open"
        type="button"
        aria-label={`Open process for ${task.title}`}
        onClick={() => onInspect(task)}
      >
        <span className="task-id">NX-{task.id.slice(0, 4).toUpperCase()}</span>
        <h3>{task.title}</h3>
        {task.description && <p>{task.description}</p>}
        {assignment && (
          <span className="task-assignment">
            <GitBranch size={12} />
            <code>{assignment.branch}</code>
            <span role={assignmentActive ? "status" : undefined}>
              {assignmentActive && <LoaderCircle className="spin" size={11} />}
              {assignment.status}
            </span>
          </span>
        )}
      </button>
      <footer>
        <div>
          {agent ? (
            <>
              <Avatar agent={agent} small />
              <span>@{agent.handle}</span>
            </>
          ) : (
            <span>Unassigned</span>
          )}
        </div>
        <div className="task-actions">
          {task.threadId && (
            <button
              type="button"
              aria-label="Open source thread"
              onClick={() => onThread(task.threadId ?? "")}
            >
              <MessageSquareMore size={13} />
            </button>
          )}
          <button
            type="button"
            disabled={position === 0}
            onClick={() => {
              void onMove(task, statuses[position - 1] ?? task.status);
            }}
            aria-label="Move left"
          >
            <ArrowLeft size={13} />
          </button>
          <button
            type="button"
            disabled={position === statuses.length - 1}
            onClick={() => {
              void onMove(task, statuses[position + 1] ?? task.status);
            }}
            aria-label="Move right"
          >
            <ArrowRight size={13} />
          </button>
        </div>
      </footer>
    </article>
  );
}

function TaskProcessDialog({
  task,
  data,
  onClose,
  onThread,
  onEdit,
  onDelete,
}: {
  task: Task;
  data: BootstrapData;
  onClose: () => void;
  onThread: (threadId: string) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const [process, setProcess] = useState<TaskProcessData>();
  const [loadError, setLoadError] = useState<string>();
  const loadProcess = useCallback(
    async (quiet = false) => {
      try {
        const next = await api<TaskProcessData>(
          `/api/tasks/${encodeURIComponent(task.id)}/process`,
        );
        setProcess(next);
        if (!quiet) setLoadError(undefined);
        return next;
      } catch (caught) {
        if (!quiet) setLoadError(messageFrom(caught));
        return undefined;
      }
    },
    [task.id],
  );

  useEffect(() => {
    setProcess(undefined);
    setLoadError(undefined);
    void loadProcess();
  }, [loadProcess]);

  const assignment = process?.assignment;
  const assignmentId = assignment?.id;
  const assignmentThreadId = assignment?.threadId;
  const isActive = assignment?.status === "queued" || assignment?.status === "running";
  useEffect(() => {
    if (!isActive || !assignmentId || !assignmentThreadId) return;
    const refreshProcess = () => void loadProcess(true);
    if (typeof window.EventSource !== "function") {
      const timer = window.setInterval(refreshProcess, 1_000);
      return () => window.clearInterval(timer);
    }
    const source = new window.EventSource(
      `/api/threads/${encodeURIComponent(assignmentThreadId)}/events`,
    );
    const onThreadEvent = (raw: Event) => {
      try {
        const event = JSON.parse((raw as MessageEvent<string>).data) as ThreadStreamEvent;
        const activity = event.activities.find((entry) => entry.runId === assignmentId);
        setProcess((current) => (current ? { ...current, activity } : current));
        if (event.refresh) refreshProcess();
      } catch {
        // EventSource reconnects automatically; the next valid event refreshes the process.
      }
    };
    source.addEventListener("thread", onThreadEvent);
    return () => {
      source.removeEventListener("thread", onThreadEvent);
      source.close();
    };
  }, [assignmentId, assignmentThreadId, isActive, loadProcess]);

  const worker = assignment
    ? data.agents.find((agent) => agent.id === assignment.workerAgentId)
    : undefined;
  const repository = assignment
    ? data.knowledge.find((item) => item.id === assignment.repositoryId)
    : undefined;
  const knownHandles = new Set(data.agents.map((agent) => agent.handle));
  const status = assignment?.status ?? "not delegated";

  return (
    <Modal
      title={process?.task.title ?? task.title}
      eyebrow="WORKER PROCESS"
      onClose={onClose}
      wide
    >
      {!process && !loadError && (
        <div className="task-process-loading">
          <LoaderCircle className="spin" size={18} />
          Loading task process…
        </div>
      )}
      {loadError && (
        <div className="run-error task-process-error">
          <CircleAlert size={15} />
          <div>
            <strong>Could not load this task</strong>
            <p>{loadError}</p>
          </div>
        </div>
      )}
      {process && (
        <div className="task-process">
          <div className="task-process-summary">
            <div>
              <span>Status</span>
              <strong className={`task-process-status status-${assignment?.status ?? "idle"}`}>
                {isActive && <LoaderCircle className="spin" size={13} />}
                {assignment?.status === "completed" && <Check size={13} />}
                {assignment?.status === "failed" && <CircleAlert size={13} />}
                {status.replace("_", " ")}
              </strong>
            </div>
            <div>
              <span>Worker</span>
              <strong>{worker ? `@${worker.handle}` : "Unassigned"}</strong>
            </div>
            <div>
              <span>Repository</span>
              <strong>{repository ? `#${repository.handle}` : "—"}</strong>
            </div>
          </div>

          <div className="task-detail-copy">
            {process.task.description ? (
              <Suspense
                fallback={<p className="message-markdown-fallback">{process.task.description}</p>}
              >
                <RichMessage content={process.task.description} knownHandles={knownHandles} />
              </Suspense>
            ) : (
              <p>No description.</p>
            )}
            <small>Updated {formatDateTime(process.task.updatedAt)}</small>
          </div>

          {!assignment ? (
            <div className="task-process-empty">
              <Bot size={22} />
              <div>
                <strong>This task has not been delegated</strong>
                <p>
                  A Master created the task but did not start a Worker assignment. Mention the
                  Master again with an available Worker and a #repository reference.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="task-process-location">
                <GitBranch size={14} />
                <div>
                  <span>Isolated branch</span>
                  <code>{assignment.branch}</code>
                </div>
                <div>
                  <span>Worktree</span>
                  <code>{assignment.worktreePath}</code>
                </div>
              </div>

              {process.activity?.thinking && (
                <details className="thinking-activity task-process-thinking">
                  <summary>
                    <Sparkles size={14} />
                    <span>Thinking</span>
                    <small>Click to view</small>
                  </summary>
                  <div className="thinking-content">
                    <Suspense
                      fallback={
                        <p className="message-markdown-fallback">{process.activity.thinking}</p>
                      }
                    >
                      <RichMessage
                        content={process.activity.thinking}
                        knownHandles={knownHandles}
                      />
                    </Suspense>
                  </div>
                </details>
              )}

              {process.toolCalls.length > 0 && (
                <section className="task-process-tools" aria-label="Worker tool calls">
                  <h3>Tool calls</h3>
                  {process.toolCalls.map((toolCall) => (
                    <div className={`tool-call tool-call-${toolCall.status}`} key={toolCall.id}>
                      <TerminalSquare size={15} />
                      <div>
                        <strong>{toolCall.name}</strong>
                        <code>{toolCall.input}</code>
                        {(toolCall.summary || toolCall.error) && (
                          <p>{toolCall.error ?? toolCall.summary}</p>
                        )}
                      </div>
                      <span>{toolCall.status.replace("_", " ")}</span>
                    </div>
                  ))}
                </section>
              )}

              {isActive && (
                <div className="task-process-live" aria-live="polite">
                  <div>
                    <LoaderCircle className="spin" size={14} />
                    <strong>{process.activity?.detail ?? "Worker is running"}</strong>
                  </div>
                  {process.activity?.text && (
                    <Suspense
                      fallback={
                        <p className="message-markdown-fallback">{process.activity.text}</p>
                      }
                    >
                      <RichMessage content={process.activity.text} knownHandles={knownHandles} />
                    </Suspense>
                  )}
                </div>
              )}

              {assignment.status === "completed" && assignment.result && (
                <section className="task-process-result">
                  <h3>Worker result</h3>
                  <Suspense
                    fallback={<p className="message-markdown-fallback">{assignment.result}</p>}
                  >
                    <RichMessage content={assignment.result} knownHandles={knownHandles} />
                  </Suspense>
                </section>
              )}

              {assignment.status === "failed" && (
                <div className="run-error task-process-error">
                  <CircleAlert size={15} />
                  <div>
                    <strong>Worker assignment failed</strong>
                    <p>{assignment.error ?? process.run?.error ?? "The Worker did not finish."}</p>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="modal-actions">
            <button type="button" onClick={() => onEdit(process.task)}>
              <Pencil size={14} />
              Edit
            </button>
            <button type="button" className="danger-button" onClick={() => onDelete(process.task)}>
              <Trash2 size={14} />
              Delete
            </button>
            {process.task.threadId && (
              <button type="button" onClick={() => onThread(process.task.threadId ?? "")}>
                <MessageSquareMore size={14} />
                Open thread
              </button>
            )}
            <button type="button" className="primary-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
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
    <Modal title="Create thread" eyebrow="NEW THREAD" onClose={onClose}>
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
        <Field label="Thread name" hint="For example: product-room">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="product-room"
            required
            maxLength={80}
          />
        </Field>
        <ModalActions onClose={onClose} saving={saving} submitLabel="Create thread" />
      </form>
    </Modal>
  );
}

function WorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Create workspace" eyebrow="NEW WORKSPACE" onClose={onClose}>
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
        <Field label="Workspace name" hint="A separate home for threads, agents, and tasks">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Product team"
            required
            maxLength={60}
          />
        </Field>
        <ModalActions onClose={onClose} saving={saving} submitLabel="Create workspace" />
      </form>
    </Modal>
  );
}

function DeleteAgentDialog({
  agent,
  onClose,
  onDeleted,
}: {
  agent: AgentView;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  return (
    <Modal
      title={`Delete @${agent.handle}?`}
      eyebrow="DANGER ZONE"
      onClose={onClose}
      closeDisabled={saving}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setFormError(undefined);
          try {
            await api(`/api/agents/${agent.id}`, { method: "DELETE" });
            await onDeleted();
          } catch (caught) {
            setFormError(messageFrom(caught));
            setSaving(false);
          }
        }}
      >
        <div className="delete-confirmation">
          <span>
            <Trash2 size={20} />
          </span>
          <p>
            This permanently deletes <strong>@{agent.handle}</strong> and any saved credential.
            Existing thread messages will remain, and tasks assigned to this agent will become
            unassigned. This action cannot be undone.
          </p>
        </div>
        {formError && (
          <p className="form-error" role="alert">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="danger-button" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={14} />}
            {saving ? "Deleting…" : "Delete agent"}
          </button>
        </div>
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
  const [workerHarness, setWorkerHarness] = useState<"codex" | "opencode">("codex");
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
      workspaceId: data.workspace.id,
      kind,
      name,
      handle,
      description: String(fields.get("description") ?? ""),
      instructions: String(fields.get("instructions") ?? ""),
    };
    const workerModel = String(fields.get("workerModel") ?? "").trim();
    const workerReasoningEffort = String(fields.get("reasoningEffort") ?? "").trim();
    const payload =
      kind === "worker"
        ? {
            ...common,
            harness: workerHarness,
            ...(workerModel ? { model: workerModel } : {}),
            ...(workerReasoningEffort ? { reasoningEffort: workerReasoningEffort } : {}),
          }
        : {
            ...common,
            accessMode: String(fields.get("accessMode") ?? "ask"),
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
    <Modal title="Create agent" eyebrow="AGENT DIRECTORY" onClose={onClose} wide>
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
              <small>Codex or OpenCode</small>
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
              <small>Conversations in Nexestra</small>
            </span>
          </button>
        </div>
        <div className="form-grid">
          <Field label="Display name">
            <input
              value={name}
              onChange={(event) => updateName(event.target.value)}
              placeholder={kind === "worker" ? "Codex Builder" : "Maya"}
              required
              maxLength={60}
            />
          </Field>
          <Field label="Handle" hint="Used for @mentions">
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
        <Field label="Description" optional>
          <input name="description" placeholder="What does this agent handle?" maxLength={240} />
        </Field>
        {kind === "worker" ? (
          <>
            <Field label="Harness">
              <div className="choice-cards">
                <label>
                  <input
                    type="radio"
                    name="harness"
                    value="codex"
                    checked={workerHarness === "codex"}
                    onChange={() => setWorkerHarness("codex")}
                  />
                  <span>
                    <b>Codex</b>
                    <small>
                      {data.runtime.harnesses.codex.installed
                        ? data.runtime.harnesses.codex.version
                        : "Not installed"}
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="harness"
                    value="opencode"
                    checked={workerHarness === "opencode"}
                    onChange={() => setWorkerHarness("opencode")}
                  />
                  <span>
                    <b>OpenCode</b>
                    <small>
                      {data.runtime.harnesses.opencode.installed
                        ? data.runtime.harnesses.opencode.version
                        : "Not installed"}
                    </small>
                  </span>
                </label>
              </div>
            </Field>
            <div className="form-grid">
              <Field
                label="Model"
                optional
                hint={
                  workerHarness === "codex"
                    ? "Leave blank to use the Codex CLI default."
                    : "Use provider/model; leave blank to use the OpenCode default."
                }
              >
                <input
                  name="workerModel"
                  aria-label="Worker model"
                  placeholder={workerHarness === "codex" ? "Default" : "provider/model"}
                  maxLength={160}
                />
              </Field>
              <Field
                label={workerHarness === "codex" ? "Reasoning effort" : "Model variant"}
                optional
                hint={
                  workerHarness === "codex"
                    ? "Leave blank to use the model or Codex profile default."
                    : "Passed to OpenCode as --variant; values depend on provider/model."
                }
              >
                <input
                  name="reasoningEffort"
                  aria-label={
                    workerHarness === "codex" ? "Reasoning effort" : "OpenCode model variant"
                  }
                  placeholder={
                    workerHarness === "codex" ? "Default, high, xhigh…" : "Default, high, max…"
                  }
                  list="worker-reasoning-suggestions"
                  maxLength={40}
                />
                <datalist id="worker-reasoning-suggestions">
                  {(workerHarness === "codex"
                    ? ["low", "medium", "high", "xhigh", "max", "ultra"]
                    : ["minimal", "low", "medium", "high", "max"]
                  ).map((effort) => (
                    <option value={effort} key={effort} />
                  ))}
                </datalist>
              </Field>
            </div>
          </>
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
                      ? "ChatGPT connected"
                      : "Connect a ChatGPT account"}
                  </strong>
                  <p>
                    Nexestra uses the session managed by Codex CLI and never reads or stores OAuth
                    tokens.
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
                    ? "Waiting…"
                    : data.runtime.chatgpt.connected
                      ? "Check"
                      : "Connect"}
                </button>
                {login?.output && <pre>{login.output}</pre>}
                <Field label="Model" optional hint="Leave blank to use the Codex default">
                  <input name="model" placeholder="Default" />
                </Field>
              </div>
            ) : (
              <CustomProviderFields />
            )}
            <MasterAccessModeField />
          </>
        )}
        <Field label="Custom instructions" optional>
          <textarea
            name="instructions"
            rows={3}
            placeholder="Role, response style, and agent boundaries…"
            maxLength={8000}
          />
        </Field>
        {formError && (
          <p className="form-error">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <ModalActions onClose={onClose} saving={saving} submitLabel="Create agent" />
      </form>
    </Modal>
  );
}

function CustomProviderFields() {
  return (
    <div className="custom-provider">
      <div className="form-grid">
        <Field label="Provider name">
          <input name="providerName" placeholder="Local gateway" required />
        </Field>
        <Field label="Protocol">
          <select name="protocol" defaultValue="openai-chat">
            <option value="openai-chat">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
          </select>
        </Field>
      </div>
      <Field label="Base URL" hint="API root: use HTTPS remotely; HTTP is limited to localhost">
        <input name="baseUrl" type="url" placeholder="https://api.example.com/v1" required />
      </Field>
      <div className="form-grid">
        <Field label="Model ID">
          <input name="model" placeholder="model-name" required />
        </Field>
        <Field label="API key" optional hint="May be left blank for a local endpoint">
          <input
            name="apiKey"
            type="password"
            autoComplete="new-password"
            placeholder="••••••••••"
          />
        </Field>
      </div>
      <p className="security-note">
        Use only an endpoint you trust. API keys are stored separately and are readable only by the
        current OS user.
      </p>
    </div>
  );
}

function MasterAccessModeField() {
  return (
    <>
      <Field
        label="Access mode"
        hint="Choose one policy for the whole agent instead of configuring individual tools."
      >
        <select name="accessMode" aria-label="Access mode" defaultValue="ask">
          <option value="ask">Ask for permission</option>
          <option value="auto">Auto</option>
          <option value="full">Full access</option>
        </select>
      </Field>
      <p className="security-note">
        Ask reviews impactful tools for custom providers and keeps ChatGPT read-only. Auto runs
        built-in tools but asks before custom or MCP tools. Full access runs every tool without
        approval and removes the Codex sandbox.
      </p>
    </>
  );
}

function KnowledgeDetailDialog({
  item,
  onClose,
  onEdit,
  onDelete,
}: {
  item: KnowledgeItem;
  onClose: () => void;
  onEdit: (item: KnowledgeItem) => void;
  onDelete: (item: KnowledgeItem) => void;
}) {
  return (
    <Modal title={item.name} eyebrow="KNOWLEDGE DETAILS" onClose={onClose}>
      <div className="resource-details">
        <div>
          <span>Reference</span>
          <strong>#{item.handle}</strong>
        </div>
        <div>
          <span>Type</span>
          <strong>{item.kind === "document" ? "Document" : "Git repository"}</strong>
        </div>
        <div className="resource-details-wide">
          <span>Description</span>
          <p>{item.description || "No description."}</p>
        </div>
        {item.kind === "document" ? (
          <>
            <div>
              <span>File</span>
              <strong>{item.fileName}</strong>
            </div>
            <div>
              <span>Size</span>
              <strong>{formatBytes(item.size)}</strong>
            </div>
            <div>
              <span>Media type</span>
              <strong>{item.mediaType}</strong>
            </div>
          </>
        ) : (
          <>
            <div className="resource-details-wide">
              <span>Source</span>
              <code>{item.source}</code>
            </div>
            <div>
              <span>Status</span>
              <strong>{item.status}</strong>
            </div>
            <div>
              <span>Default branch</span>
              <strong>{item.defaultBranch ?? "Unknown"}</strong>
            </div>
            {item.error && (
              <div className="resource-details-wide resource-details-error">
                <span>Error</span>
                <p>{item.error}</p>
              </div>
            )}
          </>
        )}
        <div>
          <span>Created</span>
          <strong>{formatDateTime(item.createdAt)}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>{formatDateTime(item.updatedAt)}</strong>
        </div>
      </div>
      <div className="modal-actions resource-actions">
        {item.kind === "document" && (
          <a href={`/api/knowledge/${encodeURIComponent(item.id)}/content`} download>
            <Download size={14} />
            Download
          </a>
        )}
        <button type="button" onClick={() => onEdit(item)}>
          <Pencil size={14} />
          Edit
        </button>
        <button type="button" className="danger-button" onClick={() => onDelete(item)}>
          <Trash2 size={14} />
          Delete
        </button>
        <button type="button" className="primary-button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function EditKnowledgeDialog({
  item,
  onClose,
  onSaved,
}: {
  item: KnowledgeItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  return (
    <Modal title={`Edit ${item.name}`} eyebrow="KNOWLEDGE" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setSaving(true);
          setFormError(undefined);
          try {
            await api(`/api/knowledge/${encodeURIComponent(item.id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                name: String(fields.get("name") ?? ""),
                handle: String(fields.get("handle") ?? ""),
                description: String(fields.get("description") ?? ""),
              }),
            });
            await onSaved();
          } catch (caught) {
            setFormError(messageFrom(caught));
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field label="Name">
          <input name="name" aria-label="Name" defaultValue={item.name} required maxLength={120} />
        </Field>
        <Field label="Reference handle" hint="Existing thread messages keep their original text.">
          <div className="handle-input">
            <span>#</span>
            <input
              name="handle"
              aria-label="Reference handle"
              defaultValue={item.handle}
              pattern="[a-z0-9][a-z0-9_-]{1,47}"
              required
              maxLength={48}
            />
          </div>
        </Field>
        <Field label="Description" optional>
          <textarea
            name="description"
            aria-label="Description"
            rows={4}
            defaultValue={item.description}
            maxLength={1000}
          />
        </Field>
        <div className="immutable-resource">
          <span>{item.kind === "document" ? "Stored file" : "Repository source"}</span>
          <code>{item.kind === "document" ? item.fileName : item.source}</code>
          <small>
            {item.kind === "document"
              ? "Delete and upload a new item to replace the file contents."
              : "Delete and clone a new item to change the repository source."}
          </small>
        </div>
        {formError && (
          <p className="form-error">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <ModalActions onClose={onClose} saving={saving} submitLabel="Save changes" />
      </form>
    </Modal>
  );
}

function DeleteKnowledgeDialog({
  item,
  hasAssignmentHistory,
  onClose,
  onDeleted,
}: {
  item: KnowledgeItem;
  hasAssignmentHistory: boolean;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  return (
    <Modal title={`Delete ${item.name}?`} eyebrow="PERMANENT DELETE" onClose={onClose}>
      <div className="delete-confirmation">
        <span>
          <Trash2 size={22} />
        </span>
        <div>
          <strong>Remove #{item.handle} from Knowledge?</strong>
          <p>
            It will disappear from the Knowledge surface and future #reference suggestions. Existing
            thread text remains unchanged.
          </p>
          {hasAssignmentHistory && item.kind === "repository" && (
            <p>
              The managed clone and historical worktrees will be retained so completed Worker runs
              remain inspectable.
            </p>
          )}
        </div>
      </div>
      {deleteError && <p className="form-error">{deleteError}</p>}
      <div className="modal-actions">
        <button type="button" disabled={deleting} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            setDeleteError(undefined);
            try {
              await api(`/api/knowledge/${encodeURIComponent(item.id)}`, { method: "DELETE" });
              await onDeleted();
            } catch (caught) {
              setDeleteError(messageFrom(caught));
              setDeleting(false);
            }
          }}
        >
          {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {deleting ? "Deleting…" : "Delete knowledge"}
        </button>
      </div>
    </Modal>
  );
}

function KnowledgeDialog({
  data,
  onClose,
  onCreated,
}: {
  data: BootstrapData;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [kind, setKind] = useState<KnowledgeItem["kind"]>("document");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleEdited, setHandleEdited] = useState(false);
  const [documentFile, setDocumentFile] = useState<File>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  return (
    <Modal title="Add knowledge" eyebrow="KNOWLEDGE" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setSaving(true);
          setFormError(undefined);
          try {
            const common = {
              workspaceId: data.workspace.id,
              name,
              handle,
              description: String(fields.get("description") ?? ""),
            };
            if (kind === "document") {
              if (!documentFile || documentFile.size === 0) {
                throw new Error("Choose a document to upload.");
              }
              const body = new FormData();
              for (const [key, value] of Object.entries(common)) body.append(key, value);
              body.append("file", documentFile);
              await api("/api/knowledge/documents", { method: "POST", body });
            } else {
              await api("/api/knowledge/repositories", {
                method: "POST",
                body: JSON.stringify({ ...common, source: String(fields.get("source") ?? "") }),
              });
            }
            await onCreated();
          } catch (caught) {
            setFormError(messageFrom(caught));
          } finally {
            setSaving(false);
          }
        }}
      >
        <fieldset className="segmented" aria-label="Knowledge type">
          <button
            type="button"
            className={kind === "document" ? "active" : ""}
            onClick={() => setKind("document")}
          >
            <FileText size={15} /> Document
          </button>
          <button
            type="button"
            className={kind === "repository" ? "active" : ""}
            onClick={() => setKind("repository")}
          >
            <GitBranch size={15} /> Git repository
          </button>
        </fieldset>
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              if (!handleEdited) setHandle(handleFromName(value));
            }}
            placeholder={kind === "document" ? "Architecture guide" : "Product repository"}
            required
            maxLength={120}
          />
        </Field>
        <Field label="Reference handle" hint="Use this in chat, for example #product-repo">
          <div className="handle-input">
            <span>#</span>
            <input
              value={handle}
              onChange={(event) => {
                setHandleEdited(true);
                setHandle(event.target.value.toLowerCase());
              }}
              placeholder="product-repo"
              pattern="[a-z0-9][a-z0-9_-]{1,47}"
              required
              maxLength={48}
            />
          </div>
        </Field>
        <Field label="Description" optional>
          <textarea name="description" rows={3} placeholder="What this knowledge contains…" />
        </Field>
        {kind === "document" ? (
          <Field label="Document" hint="The file is copied into the managed workspace.">
            <input
              name="file"
              type="file"
              onChange={(event) => setDocumentFile(event.target.files?.[0])}
            />
          </Field>
        ) : (
          <Field
            label="Repository source"
            hint="HTTPS, SSH, or an existing local Git repository path."
          >
            <input
              name="source"
              placeholder="https://github.com/owner/repository.git"
              required
              maxLength={2048}
            />
          </Field>
        )}
        {formError && (
          <p className="form-error">
            <CircleAlert size={14} />
            {formError}
          </p>
        )}
        <ModalActions
          onClose={onClose}
          saving={saving}
          submitLabel={kind === "document" ? "Upload document" : "Clone repository"}
        />
      </form>
    </Modal>
  );
}

function TaskDialog({
  data,
  task,
  initialStatus,
  onClose,
  onCreated,
}: {
  data: BootstrapData;
  task?: Task;
  initialStatus: Task["status"];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  return (
    <Modal
      title={task ? `Edit ${task.title}` : "Create task"}
      eyebrow="TASKBOARD"
      onClose={onClose}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setFormError(undefined);
          const fields = new FormData(event.currentTarget);
          try {
            await api(task ? `/api/tasks/${encodeURIComponent(task.id)}` : "/api/tasks", {
              method: task ? "PATCH" : "POST",
              body: JSON.stringify({
                ...(task ? {} : { workspaceId: data.workspace.id }),
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
        <Field label="Title">
          <input
            name="title"
            aria-label="Title"
            defaultValue={task?.title}
            placeholder="Work item to complete"
            required
            maxLength={160}
          />
        </Field>
        <Field label="Description" optional>
          <textarea
            name="description"
            aria-label="Description"
            rows={3}
            defaultValue={task?.description}
            placeholder="Desired outcome…"
            maxLength={2000}
          />
        </Field>
        <div className="form-grid">
          <Field label="Column">
            <select name="status" aria-label="Column" defaultValue={task?.status ?? initialStatus}>
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </Field>
          <Field label="Assignee" optional>
            <select name="assigneeId" aria-label="Assignee" defaultValue={task?.assigneeId ?? ""}>
              <option value="">Unassigned</option>
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
        <Field label="Linked thread" optional>
          <select name="threadId" aria-label="Linked thread" defaultValue={task?.threadId ?? ""}>
            <option value="">No linked thread</option>
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
        <ModalActions
          onClose={onClose}
          saving={saving}
          submitLabel={task ? "Save changes" : "Create task"}
        />
      </form>
    </Modal>
  );
}

function DeleteTaskDialog({
  task,
  onClose,
  onDeleted,
}: {
  task: Task;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  return (
    <Modal title={`Delete ${task.title}?`} eyebrow="PERMANENT DELETE" onClose={onClose}>
      <div className="delete-confirmation">
        <span>
          <Trash2 size={22} />
        </span>
        <div>
          <strong>Remove this task from the Taskboard?</strong>
          <p>
            This cannot be undone. Completed Worker run history remains in its linked thread, and
            retained worktrees are not deleted automatically.
          </p>
        </div>
      </div>
      {deleteError && <p className="form-error">{deleteError}</p>}
      <div className="modal-actions">
        <button type="button" disabled={deleting} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            setDeleteError(undefined);
            try {
              await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
              await onDeleted();
            } catch (caught) {
              setDeleteError(messageFrom(caught));
              setDeleting(false);
            }
          }}
        >
          {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
          {deleting ? "Deleting…" : "Delete task"}
        </button>
      </div>
    </Modal>
  );
}

function SettingsDialog({ data, onClose }: { data: BootstrapData; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Local workspace" eyebrow="SETTINGS" onClose={onClose}>
      <div className="settings-list">
        <div>
          <span>Workspace</span>
          <code>{data.workspacePath}</code>
        </div>
        <div>
          <span>Data</span>
          <code>{data.dataPath}</code>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(data.dataPath);
              setCopied(true);
            }}
          >
            <Copy size={13} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div>
          <span>Codex</span>
          <strong className={data.runtime.harnesses.codex.installed ? "ready-text" : "muted-text"}>
            {data.runtime.harnesses.codex.installed
              ? data.runtime.harnesses.codex.version
              : "Not installed"}
          </strong>
        </div>
        <div>
          <span>OpenCode</span>
          <strong
            className={data.runtime.harnesses.opencode.installed ? "ready-text" : "muted-text"}
          >
            {data.runtime.harnesses.opencode.installed
              ? data.runtime.harnesses.opencode.version
              : "Not installed"}
          </strong>
        </div>
        <div>
          <span>ChatGPT</span>
          <strong className={data.runtime.chatgpt.connected ? "ready-text" : "muted-text"}>
            {data.runtime.chatgpt.connected ? "Connected" : "Not connected"}
          </strong>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="primary-button" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  eyebrow,
  onClose,
  closeDisabled = false,
  wide = false,
  children,
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  closeDisabled?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
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
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        modalRef.current?.focus();
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
  return (
    <div className="modal-backdrop">
      <section
        ref={modalRef}
        className={wide ? "modal modal-wide" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-busy={closeDisabled || undefined}
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" disabled={closeDisabled}>
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
        {optional && <em>Optional</em>}
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
        Cancel
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

function HistoricalAgentAvatar({ name, handle }: { name: string; handle: string }) {
  const tone = ["coral", "blue", "gold", "green"][hashString(handle) % 4];
  return <span className={`avatar avatar-${tone}`}>{name.slice(0, 1).toUpperCase()}</span>;
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

function masterAccessLabel(agent: Extract<AgentView, { kind: "master" }>): string {
  if (agent.accessMode === "full") return "Full access";
  if (agent.accessMode === "auto") return "Auto";
  return "Ask for permission";
}

function hashString(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.[0] ?? "")
  ).toUpperCase();
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
    new Date(value),
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function routeFromLocation(): RouteState {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "surfaces") {
    const surface = parts[1] === "taskboard" || parts[1] === "knowledge" ? parts[1] : "agents";
    return { view: "surfaces", surface };
  }
  return { view: "threads", surface: "agents", ...(parts[1] ? { threadId: parts[1] } : {}) };
}
