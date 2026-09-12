export const KNOWLEDGE_DIFF_MAX_CHARS = 128 * 1024;
export const KNOWLEDGE_DIFF_MAX_LINES = 2_000;
export const KNOWLEDGE_DIFF_MAX_CELLS = 1_500_000;
export const KNOWLEDGE_DIFF_MAX_OUTPUT_LINES = 4_000;

export type KnowledgeDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
};

export interface KnowledgeTextDiff {
  lines: KnowledgeDiffLine[];
  insertions: number;
  deletions: number;
  truncated: boolean;
}

function emptyDiff(truncated: boolean): KnowledgeTextDiff {
  return { lines: [], insertions: 0, deletions: 0, truncated };
}

/** Compare two bounded, already-redacted text previews without mutating either source. */
export function compareKnowledgeText(before: string, after: string): KnowledgeTextDiff {
  if (before.length > KNOWLEDGE_DIFF_MAX_CHARS || after.length > KNOWLEDGE_DIFF_MAX_CHARS) {
    return emptyDiff(true);
  }
  const left = before.split("\n");
  const right = after.split("\n");
  if (
    left.length > KNOWLEDGE_DIFF_MAX_LINES ||
    right.length > KNOWLEDGE_DIFF_MAX_LINES ||
    (left.length + 1) * (right.length + 1) > KNOWLEDGE_DIFF_MAX_CELLS
  ) {
    return emptyDiff(true);
  }

  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const index = leftIndex * width + rightIndex;
      const leftLine = left[leftIndex] ?? "";
      const rightLine = right[rightIndex] ?? "";
      table[index] =
        leftLine === rightLine
          ? (table[(leftIndex + 1) * width + rightIndex + 1] ?? 0) + 1
          : Math.max(
              table[(leftIndex + 1) * width + rightIndex] ?? 0,
              table[leftIndex * width + rightIndex + 1] ?? 0,
            );
    }
  }

  const lines: KnowledgeDiffLine[] = [];
  let insertions = 0;
  let deletions = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (
      leftIndex < left.length &&
      rightIndex < right.length &&
      left[leftIndex] === right[rightIndex]
    ) {
      lines.push({ kind: "context", text: left[leftIndex] ?? "" });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    const down = leftIndex < left.length ? (table[(leftIndex + 1) * width + rightIndex] ?? 0) : -1;
    const across =
      rightIndex < right.length ? (table[leftIndex * width + rightIndex + 1] ?? 0) : -1;
    if (rightIndex < right.length && (leftIndex >= left.length || across > down)) {
      lines.push({ kind: "added", text: right[rightIndex] ?? "" });
      insertions += 1;
      rightIndex += 1;
    } else {
      lines.push({ kind: "removed", text: left[leftIndex] ?? "" });
      deletions += 1;
      leftIndex += 1;
    }
    if (lines.length > KNOWLEDGE_DIFF_MAX_OUTPUT_LINES) return emptyDiff(true);
  }
  return { lines, insertions, deletions, truncated: false };
}
