import type { Memory } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { createFakeHost } from "./fake-host.js";

const memory = (id: string, type: Memory["type"], title: string, content: string): Memory => ({
  id,
  workspaceId: "ws_1",
  type,
  title,
  content,
  links: [],
  tags: [],
  authoredBy: "master",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: `2026-09-0${id === "old" ? "1" : "2"}T00:00:00.000Z`,
});

describe("project memory search", () => {
  it("filters project-wide memory by text and type, newest first", async () => {
    const host = createFakeHost({
      memories: [
        memory("old", "decision", "Database choice", "Use SQLite for local state"),
        memory("new", "research", "Provider research", "Use the OpenAI Responses API"),
        memory("lesson", "lesson", "Retries", "Retry transport failures only"),
      ],
    });

    const byText = await host.searchMemory({ query: "openai" });
    expect(byText.memories.map((entry) => entry.id)).toEqual(["new"]);

    const byType = await host.searchMemory({ types: ["decision", "research"], limit: 1 });
    expect(byType.total).toBe(2);
    expect(byType.truncated).toBe(true);
    expect(byType.memories.map((entry) => entry.id)).toEqual(["new"]);
  });
});
