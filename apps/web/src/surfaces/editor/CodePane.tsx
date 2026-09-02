import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useRunFileContent } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";

/** CodeMirror 6 pane showing one file out of the run's worktree. */
export function CodePane({ runId, path }: { runId: string | undefined; path: string | null }) {
  const file = useRunFileContent(runId, path ?? undefined);
  const theme = useUiStore((state) => state.theme);
  const language = file.data?.language ?? "text";

  // Only the JS/TS grammar is bundled: it is what Nexestra itself is written
  // in, and shipping a mode per language would cost more than it shows.
  const extensions = useMemo(
    () =>
      language === "typescript" || language === "javascript"
        ? [javascript({ typescript: language === "typescript", jsx: true })]
        : [],
    [language],
  );

  if (!runId) return <div className="state">no run selected yet</div>;
  if (!path) return <div className="state">pick a file from the run's worktree</div>;
  if (file.isPending) return <div className="state">loading {path}…</div>;
  if (file.isError) return <div className="state">could not load {path}</div>;

  return (
    <div className="editor-host">
      <CodeMirror
        value={file.data?.content ?? ""}
        height="100%"
        theme={theme === "dark" ? oneDark : "light"}
        extensions={extensions}
        editable={false}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
        }}
      />
    </div>
  );
}
