import type { MemoryType } from "@nexestra/core";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { useMemories, useThreads } from "../../lib/api.js";
import { MEMORY_TYPE_COLOR, MEMORY_TYPES } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { buildMemoryGraph, type MemoryFlowNode } from "./layout.js";
import { MemorySidebar } from "./MemorySidebar.js";

function MemoryNode({ data, selected }: NodeProps<MemoryFlowNode>) {
  return (
    <div
      className={`mem-node${selected ? " mem-node--selected" : ""}`}
      style={{ borderLeftColor: MEMORY_TYPE_COLOR[data.memoryType] }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="mem-node__type" style={{ color: MEMORY_TYPE_COLOR[data.memoryType] }}>
        {data.memoryType}
      </div>
      <div className="mem-node__title">{data.title}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { memory: MemoryNode };

export function MemorySurface({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const threads = useThreads(workspaceId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const memories = useMemories(workspaceId);
  const selectedMemoryId = useUiStore((state) => state.selectedMemoryId);
  const selectMemory = useUiStore((state) => state.selectMemory);
  const [hidden, setHidden] = useState<ReadonlySet<MemoryType>>(new Set());

  const filtered = useMemo(
    () => (memories.data ?? []).filter((memory) => !hidden.has(memory.type)),
    [memories.data, hidden],
  );

  const graph = useMemo(() => buildMemoryGraph(filtered), [filtered]);
  const nodes = useMemo(
    () => graph.nodes.map((node) => ({ ...node, selected: node.id === selectedMemoryId })),
    [graph.nodes, selectedMemoryId],
  );

  const toggleType = (type: MemoryType) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <SurfaceLayout
      id="memory"
      title="Memory Graph"
      headerRight={
        <>
          <span className="nx-muted">
            {graph.nodes.length} nodes · {graph.edges.length} links
          </span>
          <span className="nx-muted">{thread?.title}</span>
        </>
      }
      main={
        <div className="graph">
          {memories.isPending ? <div className="state">loading memories…</div> : null}
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.08 }}
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
              nodesDraggable
              onNodeClick={(_event, node) => selectMemory(node.id)}
              onPaneClick={() => selectMemory(null)}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={16}
                size={1}
                color="var(--nx-border)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
          <div className="graph__legend">
            {MEMORY_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="graph__legend-item"
                style={{
                  border: 0,
                  background: "transparent",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  opacity: hidden.has(type) ? 0.35 : 1,
                }}
                onClick={() => toggleType(type)}
              >
                <span
                  className="graph__legend-swatch"
                  style={{ background: MEMORY_TYPE_COLOR[type] }}
                />
                {type}
              </button>
            ))}
          </div>
        </div>
      }
      sidebarTitle="Selected memory"
      sidebar={<MemorySidebar workspaceId={workspaceId} />}
    />
  );
}
