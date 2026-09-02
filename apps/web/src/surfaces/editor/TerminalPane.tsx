import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useTerminalLines } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";

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

/** Mock run output. From M4 this streams `command` events from a live run. */
export function TerminalPane() {
  const host = useRef<HTMLDivElement | null>(null);
  const lines = useTerminalLines();
  const theme = useUiStore((state) => state.theme);
  const data = lines.data;

  useEffect(() => {
    const node = host.current;
    if (!node || !data) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      theme: theme === "dark" ? DARK : LIGHT,
      scrollback: 500,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);

    const resize = () => {
      try {
        fit.fit();
      } catch {
        // The pane can be zero-sized mid-drag; ignore and retry on the next tick.
      }
    };
    resize();

    // Join instead of writeln-per-line so the last line does not push a
    // trailing blank row (which would scroll the `$ npm test` header away).
    terminal.write(data.join("\r\n"));

    const observer = new ResizeObserver(resize);
    observer.observe(node);

    return () => {
      observer.disconnect();
      terminal.dispose();
    };
  }, [data, theme]);

  return (
    <div className="nx-pane nx-pane--flush" style={{ height: "100%" }}>
      <div className="nx-pane__head">
        <span className="nx-pane__title">Terminal</span>
        <span className="nx-pane__actions nx-muted">run_opencode_1</span>
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}
