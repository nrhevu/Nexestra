import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useFileContent } from "../../lib/api.js";
import { useUiStore } from "../../lib/store.js";

/** CodeMirror 6 pane showing the `HarnessAdapter` source from the mock tree. */
export function CodePane({ path }: { path: string }) {
  const file = useFileContent(path);
  const theme = useUiStore((state) => state.theme);
  const extensions = useMemo(() => [javascript({ typescript: true, jsx: true })], []);

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
