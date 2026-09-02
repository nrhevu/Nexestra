import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useThreads } from "../lib/api.js";
import { useUiStore } from "../lib/store.js";
import { SURFACE_ROUTES, SURFACES } from "./surfaces.js";

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/** Minimal ⌘K palette: switch surface, switch thread, toggle theme. */
export function CommandPalette({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const navigate = useNavigate();
  const threads = useThreads(workspaceId);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = SURFACES.map((surface) => ({
      id: `surface:${surface.id}`,
      label: `Go to ${surface.label}`,
      hint: surface.shortcut,
      run: () =>
        void navigate({ to: SURFACE_ROUTES[surface.id], params: { workspaceId, threadId } }),
    }));

    for (const thread of threads.data ?? []) {
      list.push({
        id: `thread:${thread.id}`,
        label: `Open thread — ${thread.title}`,
        hint: thread.phase,
        run: () =>
          void navigate({ to: SURFACE_ROUTES.chat, params: { workspaceId, threadId: thread.id } }),
      });
    }

    list.push({
      id: "theme",
      label: "Toggle theme (dark / light)",
      hint: "settings",
      run: toggleTheme,
    });
    list.push({
      id: "settings",
      label: "Open Settings",
      hint: "⌘,",
      run: () => void navigate({ to: "/settings" }),
    });
    return list;
  }, [navigate, threads.data, workspaceId, threadId, toggleTheme]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    <div className="palette-backdrop">
      <button
        type="button"
        className="palette__scrim"
        aria-label="Close command palette"
        onClick={close}
      />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          // biome-ignore lint/a11y/noAutofocus: a palette must take focus when it opens
          autoFocus
          className="palette__input"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(value + 1, matches.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(value - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              matches[cursor]?.run();
              close();
            }
          }}
        />
        <div className="palette__list">
          {matches.map((command, index) => (
            <button
              key={command.id}
              type="button"
              className={`palette__item${index === cursor ? " palette__item--active" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => {
                command.run();
                close();
              }}
            >
              <span>{command.label}</span>
              <span className="palette__item-hint">{command.hint}</span>
            </button>
          ))}
          {matches.length === 0 ? <div className="state">no matches</div> : null}
        </div>
      </div>
    </div>
  );
}
