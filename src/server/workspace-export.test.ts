import { appendFile, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore, StoreError } from "./store.js";
import {
  createWorkspaceExport,
  createWorkspaceExportResponse,
  workspaceExportEntries,
} from "./workspace-export.js";
import {
  buildWorkspaceExportArchive,
  WorkspaceExportArchiveError,
} from "./workspace-export-archive.js";

const runtime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "Logged in using ChatGPT" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

class FakeRunner implements AgentRunner {
  async invoke(_agent: Agent, _invocation: AgentInvocation): Promise<string> {
    return "";
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    return runtime;
  }
}

async function openStore(
  credentials: Record<string, string> = {},
): Promise<{ store: FileStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "nexestra-export-"));
  if (Object.keys(credentials).length > 0) {
    await writeFile(join(root, "credentials.json"), JSON.stringify({ version: 1, credentials }));
  }
  const store = await FileStore.open({ root, workspacePath: root });
  return { store, root };
}

function extractZip(buffer: ArrayBuffer): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(buffer));
}

function zipEntry(zip: Record<string, Uint8Array>, path: string): Uint8Array {
  const entry = zip[path];
  if (!entry) throw new Error(`missing zip entry: ${path}`);
  return entry;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function noopAssert(): void {}

async function consumeEntries(
  prepared: Awaited<ReturnType<FileStore["prepareWorkspaceExport"]>>,
  store: FileStore,
): Promise<void> {
  for await (const entry of workspaceExportEntries(prepared, store, noopAssert)) {
    for await (const chunk of entry.chunks) {
      if (chunk.byteLength === 0) continue;
    }
  }
}

async function collectText(
  prepared: Awaited<ReturnType<FileStore["prepareWorkspaceExport"]>>,
  store: FileStore,
  archivePath: string,
): Promise<string> {
  let text = "";
  for await (const entry of workspaceExportEntries(prepared, store, noopAssert)) {
    if (entry.path !== archivePath) {
      for await (const chunk of entry.chunks) {
        if (chunk.byteLength === 0) continue;
      }
      continue;
    }
    for await (const chunk of entry.chunks) text += decode(chunk);
  }
  return text;
}

async function nextSequence(store: FileStore, threadId: string): Promise<number> {
  const raw = await readFile(store.transcriptPath(threadId), "utf8");
  let maximum = 0;
  for (const match of raw.matchAll(/"sequence":\s*(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > maximum) maximum = value;
  }
  return maximum + 1;
}

async function appendRawEvent(
  store: FileStore,
  threadId: string,
  event: Record<string, unknown>,
): Promise<void> {
  await appendFile(store.transcriptPath(threadId), `${JSON.stringify(event)}\n`);
}

async function createCustomAgent(store: FileStore, apiKey: string | undefined): Promise<Agent> {
  return store.createAgent({
    kind: "master",
    name: "Custom master",
    handle: "custom-master",
    description: "master",
    instructions: "Be helpful.",
    accessMode: "ask",
    ...(apiKey === undefined
      ? {}
      : {
          provider: {
            type: "custom" as const,
            name: "Local gateway",
            baseUrl: "http://127.0.0.1:11434/v1/",
            model: "model-a",
            protocol: "openai-chat" as const,
            apiKey,
          },
        }),
  });
}

function requireId(ids: string[], label: string): string {
  const id = ids[0];
  if (!id) throw new Error(`missing ${label}`);
  return id;
}

describe("workspace export", () => {
  it("builds a complete zip with scoped state, transcripts, uploads, and document revisions", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "helper",
      instructions: "Be helpful.",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const uploadBytes = new Uint8Array([0, 1, 2, 10, 255, 128, 42]);
    const message = await store.createUserMessage(
      thread.id,
      "Hello with upload",
      [],
      [{ name: "blob.bin", mediaType: "application/octet-stream", bytes: uploadBytes }],
    );
    const reply = await store.createAgentMessage(thread.id, agent, "Reply to upload", message.id);
    await store.setMessageFeedback(thread.id, reply.id, { value: "positive", note: "Useful" });
    const document = await store.createKnowledgeDocument(
      { name: "Plan", handle: "plan", description: "doc" },
      { name: "plan.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# Plan") },
    );
    const revisionId = document.currentRevisionId;
    if (!revisionId) throw new Error("expected revision");
    await store.createAgent({
      kind: "master",
      name: "Whiteboard secret",
      handle: "whiteboard-secret",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "whiteboard-export-secret",
      },
    });
    await store.updateWorkspaceWhiteboard(workspace.id, {
      content: "# Decisions\n\nToken: whiteboard-export-secret",
    });

    const app = createApp({ store, runner: new FakeRunner() });
    const response = await app.request(`/api/workspaces/${workspace.id}/export`);
    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    expect(Number(response.headers.get("content-length"))).toBe(buffer.byteLength);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("nexestra-workspace-");
    expect(response.headers.get("content-disposition")).toContain(".zip");

    const zip = extractZip(buffer);
    const statePath = "state.json";
    const transcriptPath = `threads/${thread.id}.jsonl`;
    const artifactId = requireId(message.artifactIds, "artifact id");
    const uploadPath = `artifacts/${thread.id}/${artifactId}`;
    const whiteboardPath = "whiteboard.md";
    const revisionPath = join(
      "workspaces",
      workspace.id,
      "knowledge",
      document.id,
      "revisions",
      revisionId,
    );
    expect(zip[statePath]).toBeDefined();
    expect(zip[transcriptPath]).toBeDefined();
    expect(zipEntry(zip, uploadPath)).toEqual(uploadBytes);
    expect(decode(zipEntry(zip, revisionPath))).toBe("# Plan");
    expect(decode(zipEntry(zip, whiteboardPath))).toBe("# Decisions\n\nToken: [REDACTED]");

    const state = JSON.parse(decode(zipEntry(zip, statePath)));
    expect(state.version).toBe(7);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].id).toBe(workspace.id);
    expect(state.threads.map((entry: { id: string }) => entry.id)).toContain(thread.id);
    expect(state.knowledge).toHaveLength(1);
    expect(state.messageFeedback).toEqual([
      expect.objectContaining({ threadId: thread.id, messageId: reply.id, value: "positive" }),
    ]);

    const manifest = JSON.parse(decode(zipEntry(zip, "manifest.json")));
    expect(manifest.format).toBe("nexestra.workspace-export");
    expect(manifest.importSupported).toBe(false);
    expect(manifest.workspace).toEqual({ id: workspace.id, name: workspace.name });
    expect(manifest.excluded).toEqual([
      "credentials",
      "harness-auth",
      "repository-files",
      "browser-state",
      "unreferenced-files",
    ]);
    const paths = manifest.entries.map((entry: { path: string }) => entry.path);
    expect(paths).toContain(statePath);
    expect(paths).toContain(transcriptPath);
    expect(paths).toContain(uploadPath);
    expect(paths).toContain(revisionPath);
    expect(paths).toContain(whiteboardPath);
    expect(paths).toContain("NOTICE.txt");
  });

  it("includes archived threads and agents while excluding the other workspace", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const archivedThread = await store.createThread({
      workspaceId: workspace.id,
      name: "Archive me",
    });
    await store.createUserMessage(archivedThread.id, "Archived", []);
    await store.archiveThread(archivedThread.id);
    const archivedAgent = await store.createAgent({
      kind: "worker",
      name: "Old",
      handle: "old",
      description: "",
      instructions: "",
      enabled: true,
      archived: true,
      harness: "codex",
      model: "model",
      reasoningEffort: "medium",
    });
    const other = await store.createWorkspace({ name: "Other" });
    const [otherThread] = store.listThreads(other.id);
    if (otherThread) {
      await store.createUserMessage(
        otherThread.id,
        "Other workspace",
        [],
        [
          {
            name: "other.bin",
            mediaType: "application/octet-stream",
            bytes: new TextEncoder().encode("other"),
          },
        ],
      );
    }

    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      const state = JSON.parse(decode(zipEntry(zip, "state.json")));
      expect(state.workspaces.map((entry: { id: string }) => entry.id)).toEqual([workspace.id]);
      expect(state.threads.some((entry: { id: string }) => entry.id === archivedThread.id)).toBe(
        true,
      );
      expect(state.agents.some((entry: { id: string }) => entry.id === archivedAgent.id)).toBe(
        true,
      );
      expect(
        state.threads.some(
          (entry: { id: string; workspaceId: string }) => entry.workspaceId === other.id,
        ),
      ).toBe(false);
      const paths = Object.keys(zip);
      expect(paths.some((path) => path.includes(`artifacts/${otherThread?.id}/`))).toBe(false);
    } finally {
      await archive.dispose();
    }
  });

  it("preserves receipt envelopes, full stored tool payloads, and unknown fields inside valid events", async () => {
    const phrase = "fixture-preserve-phrase-123456";
    const { store } = await openStore({ demo: phrase });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const requestId = "c68ab4a9-6d3e-4c4b-9f26-aaaaaaaaaaaa";
    const uploadBytes = new TextEncoder().encode("receipt upload");
    const longContent = `${"z".repeat(5_000)} ${phrase}`;
    await store.createUserMessage(
      thread.id,
      longContent,
      [],
      [{ name: "r.bin", mediaType: "application/octet-stream", bytes: uploadBytes }],
      [],
      requestId,
    );

    const input = "x".repeat(4_000);
    const error = "y".repeat(2_000);
    const now = new Date().toISOString();
    const toolCall = {
      id: "tool-full",
      runId: "run-full",
      threadId: thread.id,
      agentId: "agent-full",
      name: "bash",
      permission: "read" as const,
      status: "failed" as const,
      input,
      error,
      createdAt: now,
      updatedAt: now,
    };
    await store.updateToolCall(toolCall);
    const rawBefore = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(rawBefore).toContain(`"input":"${input}"`);
    expect(rawBefore).toContain(`"error":"${error}"`);

    await appendRawEvent(store, thread.id, {
      type: "tool.updated",
      sequence: await nextSequence(store, thread.id),
      toolCall,
      unknownObject: { nested: "kept", [`pre_${phrase}_post`]: 1 },
    });

    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      const transcript = decode(zipEntry(zip, `threads/${thread.id}.jsonl`));
      expect(transcript).not.toContain(phrase);
      expect(transcript).toContain("z".repeat(5_000));
      expect(transcript).toContain("x".repeat(4_000));
      expect(transcript).toContain("y".repeat(2_000));
      expect(transcript).toContain('"requestIdHash"');
      expect(transcript).toContain('"fingerprint"');
      expect(transcript).toContain('"artifactPlan"');
      expect(transcript).toContain('"unknownObject"');
      expect(transcript).toContain('"nested"');
      expect(transcript).toContain("[REDACTED]");
      expect(transcript).toContain('"pre_[REDACTED]_post"');
    } finally {
      await archive.dispose();
    }
  });

  it("rejects unknown event types outside the canonical envelope set", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "one", []);
    await appendRawEvent(store, thread.id, {
      type: "future.event",
      sequence: await nextSequence(store, thread.id),
      unknownObject: { nested: "kept" },
    });
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("rejects a transcript run referencing an agent from another workspace", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const other = await store.createWorkspace({ name: "Other" });
    const foreignAgent = await store.createAgent({
      kind: "worker",
      workspaceId: other.id,
      name: "Foreign",
      handle: "foreign",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      harness: "codex",
      model: "model",
      reasoningEffort: "medium",
    });
    const message = await store.createUserMessage(thread.id, "main", []);
    const now = new Date().toISOString();
    await appendRawEvent(store, thread.id, {
      type: "run.updated",
      sequence: await nextSequence(store, thread.id),
      run: {
        id: "run-foreign-agent",
        threadId: thread.id,
        triggerMessageId: message.id,
        agentId: foreignAgent.id,
        attempt: 1,
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("rejects a transcript artifact referencing a message from another thread", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const other = await store.createWorkspace({ name: "Other" });
    const [otherThread] = store.listThreads(other.id);
    if (!otherThread) throw new Error("expected other thread");
    const foreignMessage = await store.createUserMessage(otherThread.id, "foreign", []);
    await store.createUserMessage(thread.id, "main", []);
    const now = new Date().toISOString();
    await appendRawEvent(store, thread.id, {
      type: "artifact.created",
      sequence: await nextSequence(store, thread.id),
      artifact: {
        id: "artifact-foreign-message",
        threadId: thread.id,
        messageId: foreignMessage.id,
        sequence: await nextSequence(store, thread.id),
        kind: "file",
        source: "reference",
        name: "foreign.txt",
        createdAt: now,
      },
    });
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("rejects a transcript tool call referencing a run from another thread", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const other = await store.createWorkspace({ name: "Other" });
    const [otherThread] = store.listThreads(other.id);
    if (!otherThread) throw new Error("expected other thread");
    const foreignMessage = await store.createUserMessage(otherThread.id, "foreign", []);
    const now = new Date().toISOString();
    await store.updateRun({
      id: "foreign-run",
      threadId: otherThread.id,
      triggerMessageId: foreignMessage.id,
      agentId: "foreign-agent",
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await store.createUserMessage(thread.id, "main", []);
    await appendRawEvent(store, thread.id, {
      type: "tool.updated",
      sequence: await nextSequence(store, thread.id),
      toolCall: {
        id: "tool-foreign-run",
        runId: "foreign-run",
        threadId: thread.id,
        agentId: "agent-main",
        name: "read",
        permission: "read",
        status: "completed",
        input: "x",
        createdAt: now,
        updatedAt: now,
      },
    });
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("redacts a known key renamed into workspace and thread names including the manifest", async () => {
    const phrase = "fixture-rename-phrase-123456";
    const { store } = await openStore({ demo: phrase });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.updateWorkspace(workspace.id, { name: `Workspace ${phrase}` });
    await store.renameThread(thread.id, { name: `Thread ${phrase}` });
    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      const state = decode(zipEntry(zip, "state.json"));
      const manifest = decode(zipEntry(zip, "manifest.json"));
      expect(state).not.toContain(phrase);
      expect(state).toContain("[REDACTED]");
      expect(manifest).not.toContain(phrase);
      expect(manifest).toContain("[REDACTED]");
    } finally {
      await archive.dispose();
    }
  });

  it("keeps the captured credential set after rotation for text redaction", async () => {
    const oldSecret = "fixture-old-phrase-123456";
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const agent = await createCustomAgent(store, oldSecret);
    await store.createUserMessage(thread.id, `contains ${oldSecret} value`, []);
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await store.updateAgent(agent.id, {
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        removeCredential: true,
      },
    });
    try {
      const text = await collectText(prepared, store, `threads/${thread.id}.jsonl`);
      expect(text).not.toContain(oldSecret);
      expect(text).toContain("[REDACTED]");
    } finally {
      await prepared.release();
    }
  });

  it("keeps the captured credential set after rotation for binary scanning", async () => {
    const oldSecret = "fixture-old-binary-phrase-123456";
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const agent = await createCustomAgent(store, oldSecret);
    const uploadBytes = Buffer.concat([
      Buffer.alloc(65_530, 0x61),
      Buffer.from(oldSecret, "utf8"),
      Buffer.from([0, 255, 1]),
    ]);
    await store.createUserMessage(
      thread.id,
      "binary",
      [],
      [{ name: "old.bin", mediaType: "application/octet-stream", bytes: uploadBytes }],
    );
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await store.updateAgent(agent.id, {
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        removeCredential: true,
      },
    });
    let failure: unknown;
    try {
      await consumeEntries(prepared, store);
    } catch (error) {
      failure = error;
    }
    await prepared.release();
    expect(failure).toMatchObject({ code: "invalid" });
  });

  it("rejects known binary credentials instead of altering upload bytes", async () => {
    const phrase = "fixture-binary-phrase-123456";
    const { store } = await openStore({ demo: phrase });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const uploadBytes = Buffer.concat([
      Buffer.alloc(65_530, 0x61),
      Buffer.from(phrase, "utf8"),
      Buffer.from([0, 255, 1, 2]),
    ]);
    await store.createUserMessage(
      thread.id,
      "binary",
      [],
      [{ name: "phrase.bin", mediaType: "application/octet-stream", bytes: uploadBytes }],
    );

    let failure: unknown;
    try {
      await createWorkspaceExport({ store, workspaceId: workspace.id });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StoreError);
    if (!(failure instanceof StoreError)) throw new Error("expected StoreError");
    expect(failure.code).toBe("invalid");
    expect(failure.message).not.toContain(phrase);

    const other = await store.createWorkspace({ name: "Clean Other" });
    const [cleanThread] = store.listThreads(other.id);
    if (!cleanThread) throw new Error("expected clean thread");
    const cleanBytes = new Uint8Array([9, 8, 7, 6]);
    await store.createUserMessage(
      cleanThread.id,
      "clean",
      [],
      [{ name: "clean.bin", mediaType: "application/octet-stream", bytes: cleanBytes }],
    );
    const archive = await createWorkspaceExport({ store, workspaceId: other.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      const uploadPath = Object.keys(zip).find((path) => path.startsWith("artifacts/"));
      if (!uploadPath) throw new Error("expected upload entry");
      expect(zipEntry(zip, uploadPath)).toEqual(cleanBytes);
    } finally {
      await archive.dispose();
    }
  });

  it("exports an empty JSONL for empty threads and fails for missing nonempty transcripts", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [emptyThread] = store.listThreads(workspace.id);
    if (!emptyThread) throw new Error("expected seeded thread");
    const nonempty = await store.createThread({ workspaceId: workspace.id, name: "Nonempty" });
    await store.createUserMessage(nonempty.id, "hello", []);

    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      expect(zipEntry(zip, `threads/${emptyThread.id}.jsonl`).byteLength).toBe(0);
    } finally {
      await archive.dispose();
    }

    await unlink(store.transcriptPath(nonempty.id));
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("rejects missing uploads, unsafe symlinks, and corrupt document revisions without exposing phrases", async () => {
    const phrase = "fixture-symlink-phrase-123456";
    const { store, root } = await openStore({ demo: phrase });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const uploadBytes = new TextEncoder().encode("upload");
    const message = await store.createUserMessage(
      thread.id,
      "upload",
      [],
      [{ name: "u.bin", mediaType: "application/octet-stream", bytes: uploadBytes }],
    );
    const artifactId = requireId(message.artifactIds, "artifact id");
    const uploadPath = join(store.root, "artifacts", thread.id, artifactId);

    await unlink(uploadPath);
    await symlink(join(root, "credentials.json"), uploadPath);
    let failure: unknown;
    try {
      await createWorkspaceExport({ store, workspaceId: workspace.id });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StoreError);
    if (!(failure instanceof StoreError)) throw new Error("expected StoreError");
    expect(failure.code).toBe("invalid");
    expect(failure.message).not.toContain(phrase);

    await unlink(uploadPath);
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );

    await writeFile(uploadPath, uploadBytes);
    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      expect(zipEntry(zip, `artifacts/${thread.id}/${artifactId}`)).toEqual(uploadBytes);
    } finally {
      await archive.dispose();
    }
  });

  it("rejects a document revision whose bytes disagree with its stored hash", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const document = await store.createKnowledgeDocument(
      { name: "Corrupt", handle: "corrupt", description: "doc" },
      {
        name: "corrupt.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("original bytes"),
      },
    );
    const revisionId = document.currentRevisionId;
    if (!revisionId) throw new Error("expected revision");
    await writeFile(
      join(
        store.root,
        "workspaces",
        workspace.id,
        "knowledge",
        document.id,
        "revisions",
        revisionId,
      ),
      new TextEncoder().encode("tampered bytes"),
    );
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("rejects versioned document metadata that no longer matches its current revision", async () => {
    const { store, root } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    await store.createKnowledgeDocument(
      { name: "Size", handle: "size", description: "doc" },
      {
        name: "size.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Size"),
      },
    );
    const statePath = join(root, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      knowledge: Array<{ size: number }>;
    };
    const knowledgeItem = state.knowledge[0];
    if (!knowledgeItem) throw new Error("expected knowledge item");
    knowledgeItem.size += 1;
    await writeFile(statePath, JSON.stringify(state));
    const reopened = await FileStore.open({ root, workspacePath: root });
    await expect(
      createWorkspaceExport({ store: reopened, workspaceId: workspace.id }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("returns 409 when a captured source changes and keeps no stale reservation", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(
      thread.id,
      "one",
      [],
      [
        {
          name: "a.bin",
          mediaType: "application/octet-stream",
          bytes: new TextEncoder().encode("aaa"),
        },
      ],
    );
    await store.createUserMessage(
      thread.id,
      "two",
      [],
      [
        {
          name: "b.bin",
          mediaType: "application/octet-stream",
          bytes: new TextEncoder().encode("bbb"),
        },
      ],
    );
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    const artifactId = requireId(first.artifactIds, "artifact id");
    await writeFile(
      join(store.root, "artifacts", thread.id, artifactId),
      new TextEncoder().encode("abc"),
    );
    let failure: unknown;
    try {
      await consumeEntries(prepared, store);
    } catch (error) {
      failure = error;
    }
    await prepared.release();
    expect(failure).toMatchObject({ code: "conflict" });
    await expect(store.prepareWorkspaceExport(workspace.id)).resolves.toBeTruthy();
  });

  it("keeps conflict code through the real archive builder when a captured source changes", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const message = await store.createUserMessage(
      thread.id,
      "upload",
      [],
      [
        {
          name: "a.bin",
          mediaType: "application/octet-stream",
          bytes: new TextEncoder().encode("aaa"),
        },
      ],
    );
    const artifactId = requireId(message.artifactIds, "artifact id");
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await writeFile(
      join(store.root, "artifacts", thread.id, artifactId),
      new TextEncoder().encode("abc"),
    );
    let failure: unknown;
    try {
      await buildWorkspaceExportArchive({
        workspace: prepared.workspace,
        createdAt: prepared.createdAt,
        entries: workspaceExportEntries(prepared, store, noopAssert),
      });
    } catch (error) {
      failure = error;
    }
    await prepared.release();
    expect(failure).toBeInstanceOf(WorkspaceExportArchiveError);
    expect((failure as WorkspaceExportArchiveError).code).toBe("conflict");
  });

  it("does not stitch credential fragments across separate binary files", async () => {
    const phrase = "fixture-cross-file-phrase-123456";
    const { store } = await openStore({ demo: phrase });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    const bytes = Buffer.from(phrase, "utf8");
    const split = Math.floor(bytes.byteLength / 2);
    const firstBytes = new Uint8Array([0x61, 0x62, ...bytes.subarray(0, split)]);
    const secondBytes = new Uint8Array([...bytes.subarray(split), 0x63]);
    await store.createUserMessage(
      thread.id,
      "first",
      [],
      [{ name: "a.bin", mediaType: "application/octet-stream", bytes: firstBytes }],
    );
    await store.createUserMessage(
      thread.id,
      "second",
      [],
      [{ name: "b.bin", mediaType: "application/octet-stream", bytes: secondBytes }],
    );
    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    await archive.dispose();
  });

  it("revalidates a missing empty transcript path after preparation", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const emptyThread = await store.createThread({ workspaceId: workspace.id, name: "Empty" });
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await writeFile(store.transcriptPath(emptyThread.id), "");
    let failure: unknown;
    try {
      await consumeEntries(prepared, store);
    } catch (error) {
      failure = error;
    }
    await prepared.release();
    expect(failure).toMatchObject({ code: "conflict" });
  });

  it("keeps a single concurrent export reservation and releases it on failure", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await expect(store.prepareWorkspaceExport(workspace.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await prepared.release();
    const next = await store.prepareWorkspaceExport(workspace.id);
    await next.release();
    await expect(
      store.prepareWorkspaceExport(workspace.id, { timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "conflict" });
    const afterTimeout = await store.prepareWorkspaceExport(workspace.id);
    await afterTimeout.release();
  });

  it("cancels an aborted export and cleans up the reservation", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWorkspaceExport({ store, workspaceId: workspace.id, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "conflict" });
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await prepared.release();
  });

  it("bounds a stalled download and releases the archive reservation before any read", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const response = await createWorkspaceExportResponse({
      store,
      workspaceId: workspace.id,
      stallTimeoutMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(response.status).toBe(200);
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await prepared.release();
  });

  it("bounds a stalled download that already delivered the first chunk", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const response = await createWorkspaceExportResponse({
      store,
      workspaceId: workspace.id,
      stallTimeoutMs: 25,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected response body");
    const first = await reader.read();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const prepared = await store.prepareWorkspaceExport(workspace.id);
    await prepared.release();
    await reader.cancel().catch(() => undefined);
  });

  it("leaves source state and transcript bytes unchanged by an export", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "snapshot", []);
    const stateBefore = await readFile(store.stateFile);
    const transcriptBefore = await readFile(store.transcriptPath(thread.id));
    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    await archive.dispose();
    const stateAfter = await readFile(store.stateFile);
    const transcriptAfter = await readFile(store.transcriptPath(thread.id));
    expect(stateAfter).toEqual(stateBefore);
    expect(transcriptAfter).toEqual(transcriptBefore);
  });

  it("rejects colliding redacted keys with a generic error", async () => {
    const phraseA = "fixture-collide-alpha-123456";
    const phraseB = "fixture-collide-beta-123456";
    const { store } = await openStore({ alpha: phraseA, beta: phraseB });
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "one", []);
    await appendRawEvent(store, thread.id, {
      type: "tool.updated",
      sequence: await nextSequence(store, thread.id),
      toolCall: {
        id: "tool-collide",
        runId: "run-collide",
        threadId: thread.id,
        agentId: "agent-collide",
        name: "read",
        permission: "read",
        status: "completed",
        input: "x",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      [`pre_${phraseA}_post`]: 1,
      [`pre_${phraseB}_post`]: 2,
    });
    let failure: unknown;
    try {
      await createWorkspaceExport({ store, workspaceId: workspace.id });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StoreError);
    if (!(failure instanceof StoreError)) throw new Error("expected StoreError");
    expect(failure.code).toBe("invalid");
    expect(failure.message).toContain("colliding");
    expect(failure.message).not.toContain(phraseA);
    expect(failure.message).not.toContain(phraseB);
  });

  it("rejects malformed scalar transcript lines without leaking TypeError details", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "one", []);
    await appendFile(store.transcriptPath(thread.id), "null\n");
    await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject(
      { code: "invalid" },
    );
  });

  it("preserves selected workspace attention state without exporting foreign state", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const other = await store.createWorkspace({ name: "Other" });
    await store.updateAttentionState(workspace.id, "task:selected", { action: "dismiss" });
    await store.updateAttentionState(other.id, "task:foreign", { action: "dismiss" });
    const archive = await createWorkspaceExport({ store, workspaceId: workspace.id });
    try {
      const file = await readFile(archive.path);
      const zip = extractZip(
        file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      );
      const state = JSON.parse(decode(zipEntry(zip, "state.json"))) as {
        attentionStates: Array<{ workspaceId: string; attentionId: string }>;
      };
      expect(state.attentionStates).toEqual([
        {
          workspaceId: workspace.id,
          attentionId: "task:selected",
          dismissedAt: expect.any(String),
        },
      ]);
    } finally {
      await archive.dispose();
    }
  });
});
