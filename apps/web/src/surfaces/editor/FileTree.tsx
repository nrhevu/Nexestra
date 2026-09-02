import type { FileNode } from "@nexestra/core";
import { useUiStore } from "../../lib/store.js";

/** Flat list of nodes rendered as an indented tree (mock worktree contents). */
export function FileTree({ nodes }: { nodes: readonly FileNode[] }) {
  const openFilePath = useUiStore((state) => state.openFilePath);
  const openFile = useUiStore((state) => state.openFile);

  const roots = nodes.filter((node) => !node.path.includes("/"));

  const render = (node: FileNode, depth: number): React.ReactNode => {
    const children = node.children
      .map((path) => nodes.find((candidate) => candidate.path === path))
      .filter((child): child is FileNode => Boolean(child));

    return (
      <div key={node.path}>
        <button
          type="button"
          className={`tree__row${node.path === openFilePath ? " tree__row--active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => node.kind === "file" && openFile(node.path)}
        >
          <span className="tree__glyph">{node.kind === "dir" ? "▾" : "·"}</span>
          <span>{node.name}</span>
          {node.status !== "unchanged" ? (
            <span className={`tree__status tree__status--${node.status}`}>
              {node.status === "added" ? "A" : node.status === "modified" ? "M" : "D"}
            </span>
          ) : null}
        </button>
        {children.map((child) => render(child, depth + 1))}
      </div>
    );
  };

  return <div className="tree">{roots.map((node) => render(node, 0))}</div>;
}
