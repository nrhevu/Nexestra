import { describe, expect, it } from "vitest";
import { compareKnowledgeText } from "./knowledge-diff.js";

describe("compareKnowledgeText", () => {
  it("reports added and removed lines", () => {
    const result = compareKnowledgeText("keep\nold", "keep\nnew\nextra");
    expect(result.truncated).toBe(false);
    expect(result.insertions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.lines).toEqual([
      { kind: "context", text: "keep" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "added", text: "extra" },
    ]);
  });

  it("stops before allocating an unbounded diff", () => {
    const huge = Array.from({ length: 2_001 }, (_, index) => String(index)).join("\n");
    expect(compareKnowledgeText(huge, huge)).toMatchObject({ truncated: true, lines: [] });
  });
});
