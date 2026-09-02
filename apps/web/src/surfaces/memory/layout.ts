import * as dagre from "@dagrejs/dagre";
import type { Memory } from "@nexestra/core";
import type { Edge, Node } from "@xyflow/react";

export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 46;

export interface MemoryNodeData extends Record<string, unknown> {
  memoryId: string;
  title: string;
  memoryType: Memory["type"];
}

export type MemoryFlowNode = Node<MemoryNodeData, "memory">;

/** Build a dagre-laid-out graph from the memory list and its typed links. */
export function buildMemoryGraph(memories: readonly Memory[]): {
  nodes: MemoryFlowNode[];
  edges: Edge[];
} {
  const visible = new Set(memories.map((memory) => memory.id));

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "TB", nodesep: 22, ranksep: 64, marginx: 24, marginy: 24 });

  for (const memory of memories) {
    graph.setNode(memory.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  const edges: Edge[] = [];
  for (const memory of memories) {
    for (const link of memory.links) {
      if (!visible.has(link.targetId)) continue;
      graph.setEdge(memory.id, link.targetId);
      edges.push({
        id: `${memory.id}->${link.targetId}:${link.type}`,
        source: memory.id,
        target: link.targetId,
        type: "smoothstep",
        animated: link.type === "blocks",
      });
    }
  }

  dagre.layout(graph);

  const nodes: MemoryFlowNode[] = memories.map((memory) => {
    const laid = graph.node(memory.id) as { x: number; y: number } | undefined;
    return {
      id: memory.id,
      type: "memory",
      position: {
        x: (laid?.x ?? 0) - NODE_WIDTH / 2,
        y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { memoryId: memory.id, title: memory.title, memoryType: memory.type },
    };
  });

  return { nodes, edges };
}
