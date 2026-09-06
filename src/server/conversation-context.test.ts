import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProviderTextBudget,
  HISTORY_MESSAGE_CHARACTERS,
  PROVIDER_TEXT_CONTEXT_CHARACTERS,
  packRecentContext,
  providerTextSize,
  ReadHistorySchema,
  TRANSCRIPT_CONTEXT_CHARACTERS,
} from "../shared/conversation-context.js";
import { FileStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-context-"));
  roots.push(root);
  const store = await FileStore.open({ root, workspacePath: root });
  const thread = store.listThreads()[0];
  if (!thread) throw new Error("Missing thread");
  return { store, thread };
}

describe("Bounded conversation context", () => {
  it("keeps recent messages in order, marks omissions, and preserves well-formed Unicode", () => {
    const messages = Array.from(
      { length: 80 },
      (_, index) => `message-${index}: ${"Tiếng Việt 🙂 ".repeat(300)}`,
    );
    const packed = packRecentContext(messages, (message) => message, 4000);
    expect(packed.length).toBeLessThanOrEqual(4000);
    expect(packed).toContain("Bounded conversation context");
    expect(packed).toContain("message-79");
    expect(packed).not.toContain("message-0:");
    expect(new TextDecoder().decode(new TextEncoder().encode(packed))).toBe(packed);
    expect(packRecentContext(["First", "Second"], (entry) => entry)).toBe("First\n\nSecond");
    expect(packRecentContext([], (entry) => entry)).toBe("");
  });

  it("bounds the model snapshot without changing canonical messages or full exports", async () => {
    const { store, thread } = await fixture();
    const original = [];
    for (let index = 0; index < 8; index++)
      original.push(
        await store.createUserMessage(
          thread.id,
          `Message ${index}: ${"Evidence and detail. ".repeat(500)}`,
          [],
        ),
      );
    const before = await readFile(store.transcriptPath(thread.id), "utf8");
    const snapshot = await store.transcriptSnapshot(thread.id);
    expect(snapshot.length).toBeLessThanOrEqual(TRANSCRIPT_CONTEXT_CHARACTERS);
    expect(snapshot).toContain("Message 7");
    expect(snapshot).toContain("older messages omitted");
    expect(await readFile(store.transcriptPath(thread.id), "utf8")).toBe(before);
    expect(await store.exportThreadMarkdown(thread.id)).toContain(original[0]?.content);
    expect((await store.threadData(thread.id)).messages).toHaveLength(8);
  });

  it("pages backward without duplicate messages and reads a complete long message in bounded chunks", async () => {
    const { store, thread } = await fixture();
    const original = await store.createUserMessage(
      thread.id,
      `START ${"🙂 detail ".repeat(2000)} END`,
      [],
    );
    await store.createUserMessage(thread.id, "A later decision", []);
    await store.createUserMessage(thread.id, "The newest question", []);
    const newest = await store.readHistory(thread.id, { limit: 2 });
    expect(newest.messages.map((message) => message.content)).toEqual([
      "A later decision",
      "The newest question",
    ]);
    expect(newest.hasMore).toBe(true);
    const older = await store.readHistory(thread.id, {
      beforeSequence: newest.nextBeforeSequence,
      limit: 2,
    });
    expect(older.messages.map((message) => message.id)).toEqual([original.id]);
    expect(older.messages[0]?.truncated).toBe(true);
    let offset = 0;
    let content = "";
    do {
      const chunk = (await store.readHistory(thread.id, { messageId: original.id, offset }))
        .messages[0];
      if (!chunk) throw new Error("Missing chunk");
      expect(chunk.content.length).toBeLessThanOrEqual(HISTORY_MESSAGE_CHARACTERS);
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk.content))).toBe(chunk.content);
      content += chunk.content;
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    } while (offset < original.content.length);
    expect(content).toBe(original.content);
  });

  it("finds an old decision near the end of a long message and enforces thread scope", async () => {
    const { store, thread } = await fixture();
    const old = await store.createUserMessage(
      thread.id,
      `${"background ".repeat(1000)} Quyết định: ưu tiên nhà nghiên cứu`,
      [],
    );
    const match = await store.readHistory(thread.id, { query: "ƯU TIÊN" });
    expect(match.messages[0]).toMatchObject({ id: old.id, truncated: true });
    expect(match.messages[0]?.content).toContain("ưu tiên nhà nghiên cứu");
    const other = await store.createThread({ name: "Other" });
    await expect(store.readHistory(other.id, { messageId: old.id })).rejects.toThrow(
      "not found in this conversation",
    );
    expect(ReadHistorySchema.safeParse({ offset: 1 }).success).toBe(false);
    expect(ReadHistorySchema.safeParse({ messageId: old.id, query: "research" }).success).toBe(
      false,
    );
  });

  it("keeps a maximal history page within its payload budget", async () => {
    const { store, thread } = await fixture();
    for (let index = 0; index < 22; index++)
      await store.createUserMessage(thread.id, `${index}: ${"context ".repeat(300)}`, []);
    const page = await store.readHistory(thread.id, { limit: 20 });
    expect(JSON.stringify(page).length).toBeLessThan(31_000);
    expect(page.messages.length).toBeLessThan(20);
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSequence).toBe(page.messages[0]?.sequence);
  });

  it("counts text and tool schemas while keeping existing image byte limits separate", () => {
    const text = "x".repeat(PROVIDER_TEXT_CONTEXT_CHARACTERS + 1);
    expect(() => assertProviderTextBudget({ messages: [{ content: text }] })).toThrow(
      "before another request",
    );
    expect(() => assertProviderTextBudget({ tools: [{ description: text }] })).toThrow(
      "character limit",
    );
    expect(
      providerTextSize({
        image_url: { url: `data:image/png;base64,${"A".repeat(1_000_000)}` },
        content: "question",
      }),
    ).toBeLessThan(100);
    expect(providerTextSize({ content: `data:image/png;base64,${text}` })).toBeGreaterThan(
      PROVIDER_TEXT_CONTEXT_CHARACTERS,
    );
  });
});
