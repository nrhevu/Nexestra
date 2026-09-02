import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Run } from "@nexestra/core";
import { useEffect, useRef } from "react";
import { useRunEvents } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";
import { linesForRunEvent } from "./terminal.js";

const DARK = {
  background: "#0a0c0f",
  foreground: "#d6dee8",
  cursor: "#7ddba0",
  selectionBackground: "#1c2531",
};

const LIGHT = {
  background: "#fbfbf9",
  foreground: "#23262a",
  cursor: "#1e7a45",
  selectionBackground: "#e2e4e6",
};

/**
 * The live output of a harness run.
 *
 * Events arrive over `/ws` as `run.event_appended` and are folded into the
 * query cache by `lib/events.ts`, so this component only watches a growing
 * array. It keeps a cursor into that array and writes the tail: re-rendering
 * the whole scrollback on every token would flicker and would lose the user's
 * scroll position mid-run.
 */
export function TerminalPane({ run }: { run: Run | undefined }) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const written = useRef(0);
  const events = useRunEvents(run?.id);
  const theme = useUiStore((state) => state.theme);
  const rows = events.data;

  const runId = run?.id;

  // The terminal instance is tied to (run, theme): a new run starts a new
  // scrollback, and xterm cannot re-theme itself in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `runId` deliberately re-creates the scrollback
  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const instance = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      theme: theme === "dark" ? DARK : LIGHT,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(node);
    terminal.current = instance;
    written.current = 0;

    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The pane can be zero-sized mid-drag; ignore and retry on the next tick.
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);

    return () => {
      observer.disconnect();
      instance.dispose();
      terminal.current = null;
    };
  }, [theme, runId]);

  useEffect(() => {
    const instance = terminal.current;
    if (!instance || !rows) return;

    // A shorter list means the cache was replaced, not appended to — start over.
    if (rows.length < written.current) {
      instance.clear();
      written.current = 0;
    }
    for (const event of rows.slice(written.current)) {
      for (const line of linesForRunEvent(event, { colour: true })) instance.writeln(line);
    }
    written.current = rows.length;
  }, [rows]);

  return (
    <div className="nx-pane nx-pane--flush" style={{ height: "100%" }}>
      <div className="nx-pane__head">
        <span className="nx-pane__title">Terminal</span>
        <span className="nx-pane__actions nx-muted">
          {run ? `${run.harness} · ${run.kind} · ${run.id}` : "no run selected"}
        </span>
      </div>
      <div className="terminal-host" ref={host} />
      {run && (rows?.length ?? 0) === 0 ? (
        <div className="terminal-empty nx-muted">waiting for the harness to say something…</div>
      ) : null}
    </div>
  );
}
