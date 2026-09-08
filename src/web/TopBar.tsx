import { Moon, Search, Sun } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { BootstrapData } from "../shared/contracts.js";
import "./TopBar.css";

export type TopBarSurface = "taskboard" | "agents" | "knowledge" | "attention";

export interface TopBarProps {
  data: Pick<BootstrapData, "threads" | "agents" | "tasks" | "knowledge">;
  theme: "dark" | "light";
  onThemeToggle: () => void;
  onThread: (id: string) => void;
  onSurface: (surface: TopBarSurface) => void;
  onTask: (id: string) => void;
  onKnowledge: (id: string) => void;
  onSettings: () => void;
}

interface SearchResult {
  id: string;
  label: string;
  description: string;
  action: () => void;
}

export function TopBar(props: TopBarProps) {
  const [queryText, setQueryText] = useState("");
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<{ key: string; index: number }>();
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const query = queryText.trim().toLowerCase();
  const isCommand = query.startsWith("/");
  const commandResults: SearchResult[] = isCommand
    ? [
        {
          id: "command:new-thread",
          label: "New thread",
          description: "Create a new conversation thread",
          action: () => document.dispatchEvent(new CustomEvent("nexestra:new-thread")),
        },
        {
          id: "command:new-task",
          label: "New task",
          description: "Create a new task on the board",
          action: () => document.dispatchEvent(new CustomEvent("nexestra:new-task")),
        },
        {
          id: "command:taskboard",
          label: "Go to Taskboard",
          description: "Open the task management surface",
          action: () => props.onSurface("taskboard"),
        },
        {
          id: "command:attention",
          label: "Go to Attention",
          description: "Find work that needs your attention",
          action: () => props.onSurface("attention"),
        },
        {
          id: "command:agents",
          label: "Go to Agents",
          description: "Manage your agents",
          action: () => props.onSurface("agents"),
        },
        {
          id: "command:knowledge",
          label: "Go to Knowledge",
          description: "Manage your documents and repositories",
          action: () => props.onSurface("knowledge"),
        },
        {
          id: "command:settings",
          label: "Open Settings",
          description: "Configure your workspace",
          action: props.onSettings,
        },
      ].filter((command) => command.label.toLowerCase().includes(query.slice(1)))
    : [];

  const searchResults: SearchResult[] =
    query && !isCommand
      ? [
          ...props.data.threads
            .filter((thread) => thread.name.toLowerCase().includes(query))
            .map((thread) => ({
              id: `thread:${thread.id}`,
              label: `# ${thread.name}`,
              description: "Thread",
              action: () => props.onThread(thread.id),
            })),
          ...props.data.agents
            .filter((agent) => `${agent.name} ${agent.handle}`.toLowerCase().includes(query))
            .map((agent) => ({
              id: `agent:${agent.id}`,
              label: `@${agent.handle}`,
              description: "Agent",
              action: () => props.onSurface("agents"),
            })),
          ...props.data.tasks
            .filter((task) => task.title.toLowerCase().includes(query))
            .map((task) => ({
              id: `task:${task.id}`,
              label: task.title,
              description: "Task",
              action: () => props.onTask(task.id),
            })),
          ...props.data.knowledge
            .filter((item) => `${item.name} ${item.handle}`.toLowerCase().includes(query))
            .map((item) => ({
              id: `knowledge:${item.id}`,
              label: `#${item.handle}`,
              description: `${item.name} · ${item.kind === "document" ? "Document" : "Repository"}`,
              action: () => props.onKnowledge(item.id),
            })),
        ].slice(0, 8)
      : [];

  const results = isCommand ? commandResults : searchResults;
  const selectionKey = JSON.stringify([
    query,
    results.map((result) => [result.id, result.label, result.description]),
  ]);
  const selectedIndex =
    results.length === 0
      ? -1
      : selection?.key === selectionKey
        ? Math.min(selection.index, results.length - 1)
        : 0;
  const expanded = open && query.length > 0;
  const selectedId = expanded && selectedIndex >= 0 ? `${listboxId}-${selectedIndex}` : undefined;

  const execute = (result: SearchResult) => {
    setQueryText("");
    setOpen(false);
    setSelection(undefined);
    result.action();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setSelection(undefined);
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length > 0) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const index = expanded
        ? (selectedIndex + direction + results.length) % results.length
        : direction === 1
          ? 0
          : results.length - 1;
      setSelection({ key: selectionKey, index });
      setOpen(true);
      return;
    }
    const selected = results[selectedIndex];
    if (event.key === "Enter" && expanded && selected) {
      event.preventDefault();
      execute(selected);
    }
  };

  return (
    <header className="topbar">
      <div className="global-search">
        <Search size={16} />
        <input
          ref={searchRef}
          role="combobox"
          aria-label="Search threads, tasks, agents, or knowledge"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={selectedId}
          autoComplete="off"
          value={queryText}
          onChange={(event) => {
            setQueryText(event.target.value);
            setSelection(undefined);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onSearchKeyDown}
          placeholder={
            isCommand ? "Type a command..." : "Search threads, tasks, agents, or knowledge"
          }
        />
        <kbd>⌘/Ctrl K</kbd>
        {expanded && (
          <div className="search-results">
            <div id={listboxId} role="listbox" aria-label="Search results">
              {results.map((result, index) => (
                <button
                  type="button"
                  role="option"
                  id={`${listboxId}-${index}`}
                  key={result.id}
                  tabIndex={-1}
                  aria-label={`${result.label} ${result.description}`}
                  aria-selected={index === selectedIndex}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSelection({ key: selectionKey, index })}
                  onClick={() => execute(result)}
                >
                  <span>{result.label}</span>
                  <small>{result.description}</small>
                </button>
              ))}
            </div>
            {results.length === 0 && (
              <p role="status">{isCommand ? "No commands found." : "No results found."}</p>
            )}
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}
          onClick={props.onThemeToggle}
        >
          {props.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          className="profile-button"
          type="button"
          aria-label="Open settings"
          onClick={props.onSettings}
        >
          ME
          <span />
        </button>
      </div>
    </header>
  );
}
