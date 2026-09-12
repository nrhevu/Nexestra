import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, MAX_UPLOAD_BYTES, PREVIEW_BUDGET_BYTES, StoreError } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-store-"));
  return FileStore.open({ root, workspacePath: root });
}

describe("FileStore", () => {
  it("migrates version 1 metadata into a default workspace without changing record IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-store-legacy-"));
    const createdAt = "2026-09-01T10:00:00.000Z";
    await writeFile(
      join(root, "state.json"),
      `${JSON.stringify({
        version: 1,
        agents: [],
        threads: [
          {
            id: "legacy-thread",
            name: "general",
            slug: "general",
            createdAt,
            updatedAt: createdAt,
            messageCount: 0,
            lastMessageAt: null,
          },
        ],
        tasks: [],
      })}\n`,
    );

    const store = await FileStore.open({ root, workspacePath: root });
    const [workspace] = store.listWorkspaces();

    expect(workspace).toMatchObject({ name: "Nexestra", slug: "nexestra" });
    expect(store.getThread("legacy-thread")).toMatchObject({
      id: "legacy-thread",
      workspaceId: workspace?.id,
    });
    const persisted = JSON.parse(await readFile(store.stateFile, "utf8"));
    expect(persisted).toMatchObject({ version: 7, knowledge: [], assignments: [] });
  });

  it("creates isolated workspaces with their own general thread and agent handles", async () => {
    const store = await openStore();
    const [firstWorkspace] = store.listWorkspaces();
    if (!firstWorkspace) throw new Error("expected default workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });
    const firstAgent = await store.createAgent({
      kind: "worker",
      name: "Planner One",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const secondAgent = await store.createAgent({
      workspaceId: secondWorkspace.id,
      kind: "worker",
      name: "Planner Two",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "opencode",
    });

    expect(store.listThreads(firstWorkspace.id)).toHaveLength(1);
    expect(store.listThreads(secondWorkspace.id)).toMatchObject([{ name: "general" }]);
    expect(store.listAgents(firstWorkspace.id).map((agent) => agent.id)).toEqual([firstAgent.id]);
    expect(store.listAgents(secondWorkspace.id).map((agent) => agent.id)).toEqual([secondAgent.id]);
    await expect(
      store.createTask({
        workspaceId: secondWorkspace.id,
        title: "Cross-workspace assignment",
        assigneeId: firstAgent.id,
        threadId: null,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("renames without changing identity and archives/restores reversibly with slug safety", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "shared history", []);
    const transcriptPath = store.transcriptPath(thread.id);
    const transcriptBefore = await readFile(transcriptPath, "utf8");

    const renamed = await store.renameThread(thread.id, { name: "Research Log" });
    expect(renamed).toMatchObject({
      id: thread.id,
      name: "Research Log",
      slug: "research-log",
      archived: false,
    });
    expect(store.transcriptPath(thread.id)).toBe(transcriptPath);
    expect(await readFile(transcriptPath, "utf8")).toBe(transcriptBefore);

    const archived = await store.archiveThread(thread.id);
    expect(archived.archived).toBe(true);
    await expect(store.createUserMessage(thread.id, "late note", [])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(transcriptPath, "utf8")).toBe(transcriptBefore);

    const archivedSlug = await store.createThread({ name: "Research Log" });
    expect(archivedSlug.slug).toBe("research-log-2");

    const restored = await store.restoreThread(thread.id);
    expect(restored).toMatchObject({ id: thread.id, archived: false, name: "Research Log" });
    expect(await store.createUserMessage(thread.id, "back to work", [])).toMatchObject({
      threadId: thread.id,
      content: "back to work",
    });
  });

  it("refuses to archive a thread with active runs or Worker assignments", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const trigger = await store.createUserMessage(thread.id, "run me", []);
    const run = {
      id: "run-active",
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: "agent-any",
      attempt: 1,
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.updateRun(run);
    await expect(store.archiveThread(thread.id)).rejects.toMatchObject({ code: "conflict" });
    await store.updateRun({ ...run, status: "completed" });
    expect((await store.archiveThread(thread.id)).archived).toBe(true);
    await store.restoreThread(thread.id);

    const task = await store.createTask({
      title: "Archived guard",
      status: "todo",
      threadId: thread.id,
    });
    const assignment = {
      id: "assignment-active",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "",
      workerAgentId: "worker-any",
      repositoryId: "repo-any",
      status: "queued" as const,
      branch: "codex/assignment-active",
      worktreePath: "assignment-active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.createAssignment(assignment);
    await expect(store.archiveThread(thread.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("renames workspaces with unique slugs and persists the rail order", async () => {
    const store = await openStore();
    const [firstWorkspace] = store.listWorkspaces();
    if (!firstWorkspace) throw new Error("expected seeded workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });

    await expect(
      store.updateWorkspace(firstWorkspace.id, { name: "Nexus Studio" }),
    ).resolves.toMatchObject({
      id: firstWorkspace.id,
      name: "Nexus Studio",
      slug: "nexus-studio",
    });
    await expect(
      store.updateWorkspace(secondWorkspace.id, { name: "Nexus Studio" }),
    ).resolves.toMatchObject({ slug: "nexus-studio-2" });
    expect(store.listWorkspaces()).toMatchObject([
      { id: firstWorkspace.id, name: "Nexus Studio" },
      { id: secondWorkspace.id, name: "Nexus Studio" },
    ]);

    await expect(
      store.reorderWorkspaces({ workspaceIds: [secondWorkspace.id, firstWorkspace.id] }),
    ).resolves.toMatchObject([{ id: secondWorkspace.id }, { id: firstWorkspace.id }]);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.listWorkspaces()).toMatchObject([
      { id: secondWorkspace.id, name: "Nexus Studio" },
      { id: firstWorkspace.id, name: "Nexus Studio" },
    ]);
  });

  it("rejects reorder payloads that do not exactly match the current workspace list", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });

    await expect(store.reorderWorkspaces({ workspaceIds: [workspace.id] })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.reorderWorkspaces({ workspaceIds: [workspace.id, "workspace-foreign"] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.reorderWorkspaces({
        workspaceIds: [workspace.id, secondWorkspace.id, "workspace-foreign"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.reorderWorkspaces({ workspaceIds: [workspace.id, workspace.id] }),
    ).rejects.toThrow(/Include each workspace exactly once/);
    await expect(store.reorderWorkspaces({ workspaceIds: [] })).rejects.toThrow();
  });

  it("serializes workspace creation and reorder so concurrent writes cannot lose records", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const internal = store as unknown as {
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    internal.writeState = async (state) => {
      await gate;
      await writeState(state);
    };

    try {
      const reorder = store.reorderWorkspaces({ workspaceIds: [workspace.id] }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const created = store.createWorkspace({ name: "Second" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      release();
      const [orderOutcome, createdWorkspace] = await Promise.all([reorder, created]);
      expect(orderOutcome).toEqual({
        result: [expect.objectContaining({ id: workspace.id })],
      });

      const reopened = await FileStore.open({
        root: store.root,
        workspacePath: store.workspacePath,
      });
      expect(reopened.listWorkspaces()).toMatchObject([
        { id: workspace.id, name: "Nexestra" },
        { id: createdWorkspace.id, name: "Second" },
      ]);
    } finally {
      internal.writeState = writeState;
    }
  });

  it("keeps every participant's messages in one append-only thread file", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const user = await store.createUserMessage(thread.id, "@codex hello", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    await store.createAgentMessage(thread.id, agent, "Hello.", user.id);

    const data = await store.threadData(thread.id);
    expect(data.messages.map((message) => message.author.kind)).toEqual(["user", "agent"]);
    expect(data.messages[1]?.triggerMessageId).toBe(user.id);
    const transcript = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(transcript).toContain("@codex hello");
    expect(transcript).toContain("Hello.");
  });

  it("stores shared documents and resolves their #references for agents", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "Repository conventions",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture\n\nUse one canonical transcript."),
      },
    );
    const message = await store.createUserMessage(
      thread.id,
      "Use #architecture for this change.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );

    expect(store.listKnowledge()).toEqual([expect.objectContaining({ id: item.id })]);
    await expect(store.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ handle: "architecture" }),
        content: expect.stringContaining("canonical transcript"),
      }),
    ]);
    await expect(
      store.createKnowledgeDocument(
        { name: "Duplicate", handle: "architecture" },
        { name: "duplicate.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(store.knowledgePath(item), "utf8")).toContain("Architecture");
  });

  it("captures a message as redacted Knowledge with source provenance", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "super-secret-value",
      },
    });
    const message = await store.createUserMessage(
      thread.id,
      "Decision: use the local-first path. api_key=super-secret-value",
      [],
    );

    const item = await store.createKnowledgeDocumentFromMessage({
      threadId: thread.id,
      messageId: message.id,
      name: "Decision record",
      handle: "decision-record",
      description: "Captured from the discussion.",
    });

    expect(item.provenance).toEqual({
      source: "message",
      threadId: thread.id,
      messageId: message.id,
    });
    const content = await readFile(store.knowledgePath(item), "utf8");
    expect(content).toContain("Decision: use the local-first path.");
    expect(content).not.toContain("super-secret-value");
    const duplicates = await Promise.all([
      store.createKnowledgeDocumentFromMessage({
        threadId: thread.id,
        messageId: message.id,
        name: "Renamed duplicate",
        handle: "renamed-duplicate",
      }),
      store.createKnowledgeDocumentFromMessage({
        threadId: thread.id,
        messageId: message.id,
        name: "Another duplicate",
        handle: "another-duplicate",
      }),
    ]);
    expect(duplicates).toEqual([
      expect.objectContaining({ id: item.id, handle: "decision-record" }),
      expect.objectContaining({ id: item.id, handle: "decision-record" }),
    ]);
    expect(store.listKnowledge(thread.workspaceId)).toHaveLength(1);
  });

  it("updates knowledge metadata and permanently removes an unused document", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "Repository conventions",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture\n"),
      },
    );
    const file = store.knowledgePath(item);

    await expect(
      store.updateKnowledge(item.id, {
        name: "System architecture",
        handle: "system-architecture",
        description: "Current system boundaries",
      }),
    ).resolves.toMatchObject({
      name: "System architecture",
      handle: "system-architecture",
      description: "Current system boundaries",
    });
    expect(store.findKnowledgeByHandle("architecture", workspace.id)).toBeUndefined();
    expect(store.findKnowledgeByHandle("system-architecture", workspace.id)?.id).toBe(item.id);

    await store.deleteKnowledge(item.id);

    expect(store.getKnowledge(item.id)).toBeUndefined();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores uploads and indexes web and workspace-file references in the thread transcript", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await mkdir(join(store.workspacePath, "notes"), { recursive: true });
    await writeFile(join(store.workspacePath, "notes", "plan.md"), "# Plan\n");
    const message = await store.createUserMessage(
      thread.id,
      "See https://example.com/spec and `notes/plan.md`.",
      [],
      [
        {
          name: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
    );

    const data = await store.threadData(thread.id);
    expect(message.artifactIds).toHaveLength(3);
    expect(data.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "image", source: "upload", name: "diagram.png" }),
        expect.objectContaining({ kind: "link", url: "https://example.com/spec" }),
        expect.objectContaining({ kind: "file", path: "notes/plan.md" }),
      ]),
    );
    const upload = data.artifacts.find((artifact) => artifact.source === "upload");
    if (!upload) throw new Error("expected uploaded artifact");
    const content = await store.artifactContent(thread.id, upload.id);
    expect([...new Uint8Array(await readFile(content.file))]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    await expect(reopened.threadData(thread.id)).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: upload.id, messageId: message.id }),
      ]),
    });
  });

  it("bounds the display label of a reference URL longer than the artifact name limit", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const longUrl = `https://example.com/${"long-path-".repeat(24)}`;
    expect(longUrl.length).toBeGreaterThan(255);
    const content = `A long link ${longUrl} and a short one https://example.com/spec.`;
    const message = await store.createUserMessage(thread.id, content, []);
    const data = await store.threadData(thread.id);

    expect(message.content).toBe(content);
    expect(message.artifactIds).toHaveLength(2);
    const longArtifact = data.artifacts.find((artifact) => artifact.url === longUrl);
    const shortArtifact = data.artifacts.find(
      (artifact) => artifact.url === "https://example.com/spec",
    );
    if (!longArtifact || !shortArtifact) throw new Error("expected link artifacts");
    expect(longArtifact.kind).toBe("link");
    expect(longArtifact.url).toBe(longUrl);
    expect(longArtifact.name.length).toBeLessThanOrEqual(255);
    expect(longArtifact.name.endsWith("…")).toBe(true);
    expect(longArtifact.name).not.toBe(longUrl);
    expect(shortArtifact.name).toBe("https://example.com/spec");

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    await expect(reopened.threadData(thread.id)).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ url: longUrl, name: longArtifact.name }),
      ]),
    });
  });

  it("deduplicates repeated long reference URLs and indexes each distinct URL once", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const longUrl = `https://example.com/${"long-path-".repeat(24)}`;
    const otherUrl = `https://example.com/${"other-path-".repeat(24)}`;
    const message = await store.createUserMessage(
      thread.id,
      `Link ${longUrl} again ${longUrl} and ${otherUrl}`,
      [],
    );
    const data = await store.threadData(thread.id);
    const links = data.artifacts.filter((artifact) => artifact.kind === "link");

    expect(message.artifactIds).toHaveLength(2);
    expect(links).toHaveLength(2);
    for (const artifact of links) {
      expect(artifact.name.length).toBeLessThanOrEqual(255);
      expect(artifact.url).toBeTruthy();
    }
    expect(new Set(links.map((artifact) => artifact.url))).toEqual(new Set([longUrl, otherUrl]));
  });

  it("replays a long-URL user message idempotently after reopen without duplicating artifacts", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const longUrl = `https://example.com/${"long-path-".repeat(24)}`;
    const content = `Retry ${longUrl}`;
    const requestId = crypto.randomUUID();
    const first = await store.createUserMessage(thread.id, content, [], [], [], requestId);
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const replay = await reopened.createUserMessage(thread.id, content, [], [], [], requestId);
    const data = await reopened.threadData(thread.id);

    expect(replay).toMatchObject({ id: first.id, content });
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0]).toMatchObject({ kind: "link", url: longUrl });
  });

  it("indexes links and safe workspace files referenced by an agent reply", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    await writeFile(join(store.workspacePath, "result.txt"), "done\n");
    const trigger = await store.createUserMessage(thread.id, "@codex report", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const reply = await store.createAgentMessage(
      thread.id,
      agent,
      "I used [the result](result.txt) and https://example.com/run.",
      trigger.id,
    );

    const data = await store.threadData(thread.id);
    expect(data.artifacts.filter((artifact) => artifact.messageId === reply.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: "result.txt" }),
        expect.objectContaining({ kind: "link", url: "https://example.com/run" }),
      ]),
    );
  });

  it("persists trimmed Worker model settings across restarts", async () => {
    const store = await openStore();
    const created = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
      model: "  gpt-5.4  ",
      reasoningEffort: "  high  ",
    });

    expect(created).toMatchObject({ model: "gpt-5.4", reasoningEffort: "high" });
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(created.id)).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
  });

  it("loads legacy Worker records without model settings", async () => {
    const store = await openStore();
    const created = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    expect(state.agents[0]).not.toHaveProperty("model");
    expect(state.agents[0]).not.toHaveProperty("reasoningEffort");

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(created.id)).not.toHaveProperty("model");
    expect(reopened.getAgent(created.id)).not.toHaveProperty("reasoningEffort");
  });

  it("migrates version 2 Master agents to ask mode", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 2;
    delete state.agents[0].accessMode;
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getAgent(agent.id)).toMatchObject({ accessMode: "ask" });
    await expect(readFile(store.stateFile, "utf8")).resolves.toContain('"version": 7');
  });

  it("migrates version 3 Master permissions to ask mode", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 3;
    delete state.agents[0].accessMode;
    state.agents[0].permissions = { read: "allow", edit: "ask", bash: "deny" };
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getAgent(agent.id)).toMatchObject({ accessMode: "ask" });
  });

  it("migrates version 4 permission profiles to auto or full and removes the old matrix", async () => {
    const store = await openStore();
    const autoAgent = await store.createAgent({
      kind: "master",
      name: "Builder",
      handle: "builder",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    const fullAgent = await store.createAgent({
      kind: "master",
      name: "Trusted",
      handle: "trusted",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 4;
    delete state.agents[0].accessMode;
    state.agents[0].permissions = {
      read: "allow",
      edit: "allow",
      bash: "allow",
      skill: "allow",
      todowrite: "allow",
      webfetch: "ask",
      websearch: "ask",
      question: "allow",
      external: "ask",
    };
    delete state.agents[1].accessMode;
    state.agents[1].permissions = Object.fromEntries(
      Object.keys(state.agents[0].permissions).map((key) => [key, "allow"]),
    );
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const migratedAuto = reopened.getAgent(autoAgent.id);
    const migratedFull = reopened.getAgent(fullAgent.id);

    expect(migratedAuto).toMatchObject({ accessMode: "auto" });
    expect(migratedFull).toMatchObject({ accessMode: "full" });
    expect(migratedAuto).not.toHaveProperty("permissions");
    expect(migratedFull).not.toHaveProperty("permissions");
  });

  it("migrates version 6 tasks to the verification contract", async () => {
    const store = await openStore();
    const task = await store.createTask({
      title: "Existing task",
      description: "Existing description",
      status: "todo",
      assigneeId: null,
      threadId: null,
      verificationCommand: "pnpm test",
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 6;
    delete state.tasks[0].verificationCommand;
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getTask(task.id)).toMatchObject({ verificationCommand: "" });
    await expect(readFile(store.stateFile, "utf8")).resolves.toContain('"version": 7');
  });

  it("never writes a custom provider key to public state or transcripts", async () => {
    const store = await openStore();
    const secret = "sk-super-secret";
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });

    expect(store.getCredential(agent.id)).toBe(secret);
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
    expect(JSON.stringify(store.listAgents())).not.toContain(secret);
  });

  it("redacts legacy short credentials without corrupting ordinary text", async () => {
    const store = await openStore();
    await writeFile(
      store.credentialFile,
      `${JSON.stringify({ version: 1, credentials: { legacy: "a" } })}\n`,
    );
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });

    expect(reopened.redactSecrets("data; key=a; exact a")).toBe(
      "data; key=[REDACTED]; exact [REDACTED]",
    );
  });

  it("permanently deletes an agent, its credential, and current task assignments", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const secret = "sk-delete-me";
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const task = await store.createTask({
      title: "Review the plan",
      description: "",
      status: "todo",
      assigneeId: agent.id,
      threadId: null,
    });
    const trigger = await store.createUserMessage(thread.id, "@maya keep this history", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    await store.createAgentMessage(thread.id, agent, "This reply stays.", trigger.id);
    const transcriptBefore = await readFile(store.transcriptPath(thread.id), "utf8");

    await store.deleteAgent(agent.id);

    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.findAgentByHandle(agent.handle)).toBeUndefined();
    expect(store.getCredential(agent.id)).toBeUndefined();
    expect(store.listTasks().find((entry) => entry.id === task.id)?.assigneeId).toBeNull();
    expect(await readFile(store.transcriptPath(thread.id), "utf8")).toBe(transcriptBefore);
    const credentials = JSON.parse(await readFile(store.credentialFile, "utf8"));
    expect(credentials.credentials).not.toHaveProperty(agent.id);
    expect(JSON.stringify(credentials)).not.toContain(secret);

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(agent.id)).toBeUndefined();
    expect(reopened.listTasks().find((entry) => entry.id === task.id)?.assigneeId).toBeNull();
    await expect(reopened.deleteAgent(agent.id)).rejects.toMatchObject({ code: "not_found" });

    await expect(
      reopened.createAgent({
        kind: "worker",
        name: "New Maya",
        handle: "maya",
        description: "",
        instructions: "",
        harness: "codex",
      }),
    ).resolves.toMatchObject({ handle: "maya" });
  });

  it("keeps the durable intermediate state retryable when state persistence fails", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "sk-delete-me",
      },
    });
    const internal = store as unknown as {
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };

    try {
      await expect(store.deleteAgent(agent.id)).rejects.toThrow("simulated state write failure");
      expect(store.getAgent(agent.id)).toBeDefined();
      expect(store.getCredential(agent.id)).toBeUndefined();
      expect(await readFile(store.stateFile, "utf8")).toContain(agent.id);
      expect(await readFile(store.credentialFile, "utf8")).not.toContain(agent.id);
    } finally {
      internal.writeState = writeState;
    }

    await expect(store.deleteAgent(agent.id)).resolves.toBeUndefined();
    expect(store.getAgent(agent.id)).toBeUndefined();
  });

  it("rejects unsafe custom provider URLs", async () => {
    const store = await openStore();
    const input = {
      kind: "master" as const,
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        model: "model-a",
        protocol: "openai-chat" as const,
      },
    };

    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "http://example.com/v1" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "https://user:pass@example.com/v1?token=x" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("pins document references at persistence and resolves original bytes after replacement", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const oldMessage = await store.createUserMessage(
      thread.id,
      "Use #architecture for this change.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(oldMessage.knowledgeReferences[0]?.revisionId).toBe(item.currentRevisionId);
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: item.currentRevisionId },
      {
        name: "architecture-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    expect(replaced.currentRevisionId).not.toBe(item.currentRevisionId);
    expect(replaced.revisions).toHaveLength(2);
    expect(await readFile(store.knowledgePath(replaced), "utf8")).toBe("# Architecture v2");
    expect(await store.agentKnowledge(oldMessage)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          fileName: "architecture.md",
          storagePath: expect.stringContaining("/revisions/"),
        }),
        content: "# Architecture v1",
      }),
    ]);
    const newMessage = await store.createUserMessage(
      thread.id,
      "Use the latest #architecture now.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(newMessage.knowledgeReferences[0]?.revisionId).toBe(replaced.currentRevisionId);
    await expect(store.agentKnowledge(newMessage)).resolves.toEqual([
      expect.objectContaining({ content: "# Architecture v2" }),
    ]);
  });

  it("restores a prior document revision as a new current version", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const firstRevisionId = item.currentRevisionId;
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: firstRevisionId },
      {
        name: "architecture-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    if (!firstRevisionId) throw new Error("expected first revision");
    const restored = await store.restoreKnowledgeDocumentRevision(item.id, firstRevisionId, {
      expectedRevisionId: replaced.currentRevisionId,
    });
    if (restored.kind !== "document") throw new Error("expected document");
    expect(restored.currentRevisionId).not.toBe(firstRevisionId);
    expect(restored.revisions).toHaveLength(3);
    expect(restored.revisions.at(-1)?.restoredFromId).toBe(firstRevisionId);
    expect(restored.fileName).toBe("architecture.md");
    expect(await readFile(store.knowledgePath(restored), "utf8")).toBe("# Architecture v1");
    const oldBytes = await store.documentRevisionContent(item.id, firstRevisionId);
    expect(new TextDecoder().decode(oldBytes.bytes)).toBe("# Architecture v1");
  });

  it("captures a legacy document when a new message pins it and keeps provenance after replacement", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Legacy notes",
        handle: "legacy-notes",
        description: "",
      },
      {
        name: "legacy.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy original"),
      },
    );
    const internal = store as unknown as { state: { knowledge: Array<Record<string, unknown>> } };
    const legacyRoot = store.knowledgePath(item);
    internal.state.knowledge = internal.state.knowledge.map((entry) =>
      entry.id === item.id ? { ...entry, revisions: [], currentRevisionId: undefined } : entry,
    );
    const before = await store.createUserMessage(
      store.listThreads()[0]?.id ?? "",
      "Use #legacy-notes",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(before.knowledgeReferences[0]?.revisionId).toBeTruthy();
    const captured = store.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected document");
    expect(captured.revisions).toHaveLength(1);
    expect(captured.storagePath).toContain("/revisions/");
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: before.knowledgeReferences[0]?.revisionId ?? "" },
      {
        name: "legacy-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    expect(replaced.revisions).toHaveLength(2);
    expect(replaced.createdAt).toBe(item.createdAt);
    expect(replaced.revisions[0]).toMatchObject({
      fileName: "legacy.md",
      createdAt: before.createdAt,
    });
    expect(await store.documentRevisionContent(item.id, replaced.revisions[0]?.id ?? "")).toEqual(
      expect.objectContaining({
        bytes: expect.any(Uint8Array),
      }),
    );
    const legacyContent = await store.documentRevisionContent(
      item.id,
      replaced.revisions[0]?.id ?? "",
    );
    expect(new TextDecoder().decode(legacyContent.bytes)).toBe("# Legacy original");
    await expect(store.agentKnowledge(before)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);
    expect(await readFile(legacyRoot, "utf8")).toBe("# Legacy original");
  });

  it("keeps a legacy capture published when message state write fails after transcript append", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      { name: "Legacy notes", handle: "legacy-notes", description: "" },
      {
        name: "legacy.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy original"),
      },
    );
    const internal = store as unknown as {
      state: { knowledge: Array<Record<string, unknown>> };
      writeState: (state?: unknown) => Promise<void>;
    };
    internal.state.knowledge = internal.state.knowledge.map((entry) =>
      entry.id === item.id ? { ...entry, revisions: [], currentRevisionId: undefined } : entry,
    );
    let writeCount = 0;
    const originalWrite = internal.writeState.bind(store);
    internal.writeState = async (state) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error("simulated message state write failure");
      return originalWrite(state);
    };
    await expect(
      store.createUserMessage(
        store.listThreads()[0]?.id ?? "",
        "Use #legacy-notes",
        [],
        [],
        [{ knowledgeId: item.id, handle: item.handle }],
      ),
    ).rejects.toThrow("simulated message state write failure");

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(store.listThreads()[0]?.id ?? "");
    const message = data.messages.find(
      (entry) => entry.author.kind === "user" && entry.knowledgeReferences.length > 0,
    );
    if (!message) throw new Error("expected pinned message after reopen");
    expect(message.knowledgeReferences[0]?.revisionId).toBeTruthy();
    const captured = reopened.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected captured document");
    expect(captured.revisions).toHaveLength(1);
    expect(captured.currentRevisionId).toBe(message.knowledgeReferences[0]?.revisionId);
    await expect(reopened.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);

    const replaced = await reopened.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: captured.currentRevisionId },
      {
        name: "legacy-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected replaced document");
    await expect(reopened.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);
  });
  it("rejects stale or foreign document revision mutations and missing revisions", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const other = await store.createKnowledgeDocument(
      {
        name: "Other notes",
        handle: "other",
        description: "",
      },
      {
        name: "other.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Other"),
      },
    );
    await expect(store.documentRevisionContent(item.id, "missing-revision")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.restoreKnowledgeDocumentRevision(item.id, "missing-revision", {
        expectedRevisionId: item.currentRevisionId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.replaceKnowledgeDocument(
        item.id,
        { expectedRevisionId: "stale" },
        {
          name: "stale.md",
          mediaType: "text/markdown",
          bytes: new TextEncoder().encode("# Stale"),
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.restoreKnowledgeDocumentRevision(item.id, other.revisions[0]?.id ?? "", {
        expectedRevisionId: item.currentRevisionId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const repository = await store.createKnowledgeRepository({
      name: "Repository",
      handle: "repo",
      description: "",
      source: "/tmp/source",
    });
    await expect(
      store.replaceKnowledgeDocument(
        repository.id,
        { expectedRevisionId: "legacy" },
        { name: "repo.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rolls back a document replacement when the state write fails", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const originalWrite = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(
        store.replaceKnowledgeDocument(
          item.id,
          { expectedRevisionId: item.currentRevisionId },
          {
            name: "architecture-v2.md",
            mediaType: "text/markdown",
            bytes: new TextEncoder().encode("# Architecture v2"),
          },
        ),
      ).rejects.toThrow("simulated state write failure");
    } finally {
      internal.writeState = originalWrite;
    }
    expect(store.getKnowledge(item.id)).toMatchObject({
      fileName: "architecture.md",
      currentRevisionId: item.currentRevisionId,
      storagePath: item.storagePath,
    });
    expect(await readFile(store.knowledgePath(item), "utf8")).toBe("# Architecture v1");
    const revisionDirectory = dirname(item.storagePath);
    expect(await readdir(join(store.root, revisionDirectory))).toEqual([item.currentRevisionId]);
  });

  it("previews current and historical revisions with bounded UTF-8 text and redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-preview-store-"));
    const secret = "sk-preview-secret-abc123";
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({ version: 1, credentials: { worker: secret } }),
    );
    const store = await FileStore.open({ root, workspacePath: root });
    const oldBytes = new TextEncoder().encode(`# Old\nBearer ${secret}\n`);
    const item = await store.createKnowledgeDocument(
      { name: "Preview guide", handle: "preview-guide", description: "" },
      { name: "preview.md", mediaType: "text/markdown", bytes: oldBytes },
    );
    const firstRevisionId = item.currentRevisionId;
    const largeBytes = Buffer.concat([
      Buffer.alloc(PREVIEW_BUDGET_BYTES, 0x41),
      Buffer.from("😀"),
      Buffer.from("tail"),
    ]);
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: firstRevisionId },
      { name: "preview-large.md", mediaType: "text/plain", bytes: largeBytes },
    );
    if (replaced.kind !== "document") throw new Error("expected document");

    const current = await store.previewKnowledgeDocument(item.id);
    expect(current).toMatchObject({
      revisionId: replaced.currentRevisionId,
      isCurrent: true,
      fileName: "preview-large.md",
      mediaType: "text/plain",
      supported: true,
      truncated: true,
    });
    expect(current.text).not.toContain("😀");
    expect(Buffer.byteLength(current.text ?? "", "utf8")).toBe(PREVIEW_BUDGET_BYTES);
    expect(JSON.stringify(current)).not.toContain("workspaces");

    const old = await store.previewKnowledgeDocument(item.id, firstRevisionId);
    expect(old).toMatchObject({
      revisionId: firstRevisionId,
      isCurrent: false,
      fileName: "preview.md",
      supported: true,
      truncated: false,
    });
    expect(old.text).toContain("# Old");
    expect(old.text).not.toContain(secret);
    expect(old.text).toContain("[REDACTED]");
  });

  it("keeps an intact final multibyte character and cuts a split one at the preview budget", async () => {
    const store = await openStore();
    const small = await store.createKnowledgeDocument(
      { name: "Emoji", handle: "emoji-preview", description: "" },
      { name: "emoji.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("Hello 😀") },
    );
    const smallPreview = await store.previewKnowledgeDocument(small.id);
    expect(smallPreview).toMatchObject({ supported: true, truncated: false });
    expect(smallPreview.text).toBe("Hello 😀");
    const split = await store.createKnowledgeDocument(
      { name: "Split", handle: "split-preview", description: "" },
      {
        name: "split.txt",
        mediaType: "text/plain",
        bytes: Buffer.concat([Buffer.alloc(PREVIEW_BUDGET_BYTES, 0x41), Buffer.from("😀tail")]),
      },
    );
    const splitPreview = await store.previewKnowledgeDocument(split.id);
    expect(splitPreview).toMatchObject({ supported: true, truncated: true });
    expect(splitPreview.text).toBe("A".repeat(PREVIEW_BUDGET_BYTES));
    expect(splitPreview.text).not.toContain("😀");
    expect(Buffer.byteLength(splitPreview.text ?? "", "utf8")).toBe(PREVIEW_BUDGET_BYTES);
  });

  it("rejects previewing a revision grown past the upload cap after creation", async () => {
    const store = await openStore();
    const exact = Buffer.alloc(MAX_UPLOAD_BYTES, 0x41);
    const item = await store.createKnowledgeDocument(
      { name: "Exact cap", handle: "exact-preview-cap", description: "" },
      { name: "exact.txt", mediaType: "text/plain", bytes: exact },
    );
    await appendFile(store.knowledgePath(item), Buffer.from("x"));
    await expect(store.previewKnowledgeDocument(item.id)).rejects.toMatchObject({
      code: "invalid",
      message: "Knowledge document file is too large.",
    });
  });

  it("redacts preview metadata and cuts before a secret split at the preview budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-preview-secret-"));
    const metadataSecret = "sk-preview-meta-secret";
    const splitSecret = `sk-split-secret-${"x".repeat(1024)}`;
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({ version: 1, credentials: { meta: metadataSecret, split: splitSecret } }),
    );
    const store = await FileStore.open({ root, workspacePath: root });
    const binary = await store.createKnowledgeDocument(
      { name: "Secret diagram", handle: "secret-diagram", description: "" },
      {
        name: `${metadataSecret}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    );
    const unsupported = await store.previewKnowledgeDocument(binary.id);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.fileName).not.toContain(metadataSecret);
    expect(JSON.stringify(unsupported)).not.toContain(metadataSecret);
    const textItem = await store.createKnowledgeDocument(
      { name: "Secret notes", handle: "secret-notes", description: "" },
      {
        name: `${metadataSecret}.txt`,
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("plain"),
      },
    );
    const supported = await store.previewKnowledgeDocument(textItem.id);
    expect(supported.supported).toBe(true);
    expect(supported.fileName).not.toContain(metadataSecret);
    expect(JSON.stringify(supported)).not.toContain(metadataSecret);
    const secretStart = PREVIEW_BUDGET_BYTES - 512;
    const splitItem = await store.createKnowledgeDocument(
      { name: "Split secret", handle: "split-secret", description: "" },
      {
        name: "split-secret.txt",
        mediaType: "text/plain",
        bytes: Buffer.concat([
          Buffer.alloc(secretStart, 0x41),
          Buffer.from(splitSecret, "utf8"),
          Buffer.from("\ntail"),
        ]),
      },
    );
    const emojiItem = await store.createKnowledgeDocument(
      { name: "Emoji split secret", handle: "emoji-split-secret", description: "" },
      {
        name: "emoji-split-secret.txt",
        mediaType: "text/plain",
        bytes: Buffer.concat([
          Buffer.alloc(PREVIEW_BUDGET_BYTES - 4 - 512, 0x41),
          Buffer.from("😀"),
          Buffer.from(splitSecret, "utf8"),
          Buffer.from("\ntail"),
        ]),
      },
    );
    const emojiPreview = await store.previewKnowledgeDocument(emojiItem.id);
    expect(emojiPreview.supported).toBe(true);
    expect(emojiPreview.text).toContain("😀");
    expect(Buffer.byteLength(emojiPreview.text ?? "", "utf8")).toBeLessThanOrEqual(
      PREVIEW_BUDGET_BYTES,
    );
    expect(emojiPreview.text).not.toContain(splitSecret.slice(0, 32));
    expect(emojiPreview.text).not.toContain("tail");
    const preview = await store.previewKnowledgeDocument(splitItem.id);
    expect(preview.supported).toBe(true);
    expect(Buffer.byteLength(preview.text ?? "", "utf8")).toBeLessThanOrEqual(PREVIEW_BUDGET_BYTES);
    expect(preview.text).not.toContain(splitSecret.slice(0, 32));
    expect(preview.text).not.toContain("tail");
    expect(JSON.stringify(preview)).not.toContain(splitSecret);
  });

  it("keeps oversized legacy credentials readable and disables preview with a download fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-preview-oversize-"));
    const oversized = `sk-oversize-${"x".repeat(20_000)}`;
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({ version: 1, credentials: { legacy: oversized } }),
    );
    const store = await FileStore.open({ root, workspacePath: root });
    expect(store.listWorkspaces()).toHaveLength(1);
    const item = await store.createKnowledgeDocument(
      { name: "Legacy notes", handle: "oversize-notes", description: "" },
      {
        name: "notes.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(`prefix ${oversized.slice(0, 64)}`),
      },
    );
    const preview = await store.previewKnowledgeDocument(item.id);
    expect(preview.supported).toBe(false);
    expect(preview.text).toBeUndefined();
    expect(preview.truncated).toBe(false);
    expect(preview.fileName).toBe("notes.txt");
    expect(preview.reason).toContain("Download");
    expect(JSON.stringify(preview)).not.toContain(oversized.slice(0, 64));
  });

  it("previews a legacy unpinned document without inventing revision metadata", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      { name: "Legacy preview", handle: "legacy-preview", description: "" },
      {
        name: "legacy.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("Legacy plain text."),
      },
    );
    const internal = store as unknown as {
      state: { knowledge: Array<Record<string, unknown>> };
    };
    internal.state.knowledge = internal.state.knowledge.map((entry) =>
      entry.id === item.id ? { ...entry, revisions: [], currentRevisionId: undefined } : entry,
    );

    const preview = await store.previewKnowledgeDocument(item.id);
    expect(preview.revisionId).toBeUndefined();
    expect(preview).toMatchObject({
      isCurrent: true,
      fileName: "legacy.txt",
      supported: true,
      truncated: false,
      text: "Legacy plain text.",
    });
    const captured = store.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected document");
    expect(captured.revisions).toHaveLength(0);
    expect(captured.currentRevisionId).toBeUndefined();
  });

  it("rejects unsupported, invalid UTF-8, corrupted, missing, and foreign previews", async () => {
    const store = await openStore();
    const binary = await store.createKnowledgeDocument(
      { name: "Diagram", handle: "diagram", description: "" },
      {
        name: "diagram.png",
        mediaType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    );
    const invalidBytes = Buffer.concat([Buffer.from("ok"), Buffer.from([0xff])]);
    const invalid = await store.createKnowledgeDocument(
      { name: "Invalid UTF-8", handle: "invalid-utf8", description: "" },
      { name: "broken.txt", mediaType: "text/plain", bytes: invalidBytes },
    );
    const other = await store.createKnowledgeDocument(
      { name: "Other", handle: "other-preview", description: "" },
      {
        name: "other.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("Other"),
      },
    );
    const repository = await store.createKnowledgeRepository({
      name: "Repo",
      handle: "preview-repo",
      description: "",
      source: "/tmp/source",
    });

    const unsupported = await store.previewKnowledgeDocument(binary.id);
    expect(unsupported.supported).toBe(false);
    expect(unsupported.text).toBeUndefined();
    expect(unsupported.reason).toContain("cannot be previewed");
    const invalidPreview = await store.previewKnowledgeDocument(invalid.id);
    expect(invalidPreview.supported).toBe(false);
    expect(invalidPreview.reason).toContain("valid UTF-8");

    await writeFile(store.knowledgePath(other), "tampered");
    await expect(store.previewKnowledgeDocument(other.id)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(store.previewKnowledgeDocument(invalid.id, "missing")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.previewKnowledgeDocument(invalid.id, other.revisions[0]?.id ?? ""),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(store.previewKnowledgeDocument(repository.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("rejects duplicate handles case-insensitively", async () => {
    const store = await openStore();
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    await expect(
      store.createAgent({
        kind: "worker",
        name: "Other",
        handle: "CODEX",
        description: "",
        instructions: "",
        harness: "opencode",
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("creates a task directly in the selected board column", async () => {
    const store = await openStore();
    const task = await store.createTask({
      title: "Review",
      description: "",
      status: "in_progress",
      assigneeId: null,
      threadId: null,
    });
    expect(task.status).toBe("in_progress");
  });

  it("updates and deletes a task while protecting active Worker assignments", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const worker = await store.createAgent({
      kind: "worker",
      name: "Builder",
      handle: "builder",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const repository = await store.createKnowledgeRepository({
      name: "Product repository",
      handle: "product-repo",
      source: "https://github.com/example/product.git",
    });
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: "main",
    });
    const task = await store.createTask({
      title: "Initial task",
      description: "Initial description",
      assigneeId: worker.id,
      threadId: thread.id,
    });
    const now = new Date().toISOString();
    const assignment = await store.createAssignment({
      id: "assignment-active",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "master-run",
      workerAgentId: worker.id,
      repositoryId: repository.id,
      status: "running",
      branch: "nexestra/assignment-active",
      worktreePath: "workspaces/workspace/worktrees/assignment-active",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      store.updateTask(task.id, {
        title: "Updated task",
        description: "Updated description",
        status: "in_progress",
      }),
    ).resolves.toMatchObject({
      title: "Updated task",
      description: "Updated description",
      status: "in_progress",
    });
    await expect(store.deleteTask(task.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.deleteKnowledge(repository.id)).rejects.toMatchObject({ code: "conflict" });

    await store.updateAssignment(assignment.id, { status: "completed" });
    await store.deleteTask(task.id);
    await store.deleteKnowledge(repository.id);

    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.getKnowledge(repository.id)).toBeUndefined();
  });

  it("replays message order after restart and marks an unfinished run interrupted", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "one", []);
    const second = await store.createUserMessage(thread.id, "two", []);
    const now = new Date().toISOString();
    await store.updateRun({
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: second.id,
      agentId: crypto.randomUUID(),
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(data.runs[0]?.status).toBe("interrupted");
  });

  it("replays tool events and interrupts pending approval and input after restart", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const now = new Date().toISOString();
    const run = await store.updateRun({
      id: "run-pending",
      threadId: thread.id,
      triggerMessageId: "message",
      agentId: "agent",
      attempt: 1,
      status: "waiting_approval",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: "tool-pending",
      runId: run.id,
      threadId: thread.id,
      agentId: run.agentId,
      name: "bash",
      permission: "bash",
      status: "waiting_approval",
      input: '{"command":"pnpm test"}',
      createdAt: now,
      updatedAt: now,
    });
    const inputRun = await store.updateRun({
      id: "run-input",
      threadId: thread.id,
      triggerMessageId: "message",
      agentId: "agent",
      attempt: 1,
      status: "waiting_input",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: "tool-input",
      runId: inputRun.id,
      threadId: thread.id,
      agentId: inputRun.agentId,
      name: "question",
      permission: "question",
      status: "waiting_input",
      input:
        '{"questions":[{"question":"Continue?","header":"Confirm","options":[{"label":"Yes","description":"Continue the run."}]}]}',
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);

    expect(data.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: run.id, status: "interrupted" }),
        expect.objectContaining({ id: inputRun.id, status: "interrupted" }),
      ]),
    );
    expect(data.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool-pending", status: "interrupted" }),
        expect.objectContaining({ id: "tool-input", status: "interrupted" }),
      ]),
    );
  });

  it("repairs a partial JSONL tail before appending another event", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "before crash", []);
    await appendFile(store.transcriptPath(thread.id), '{"type":"message.created","sequence":2');

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const second = await reopened.createUserMessage(thread.id, "after crash", []);
    const data = await reopened.threadData(thread.id);

    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(second.sequence).toBe(2);
  });

  it("completes a recovered run when its reply was already persisted", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const trigger = await store.createUserMessage(thread.id, "@codex reply", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: agent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.updateRun(run);
    await store.createAgentMessage(thread.id, agent, "synced reply", trigger.id);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.runs[0]?.status).toBe("completed");
  });
});

describe("FileStore agent profile updates", () => {
  it("updates Worker identity, harness, and optional model fields, keeping the handle unique", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "worker",
      name: "Old Planner",
      handle: "old-planner",
      description: "",
      instructions: "",
      harness: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
    });
    await store.createAgent({
      kind: "worker",
      name: "Reserved",
      handle: "reserved",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const updated = await store.updateAgent(agent.id, {
      name: "New Planner",
      handle: "planner",
      description: "Plans the work",
      instructions: "Keep replies short.",
      harness: "opencode",
      model: null,
      reasoningEffort: "max",
    });
    expect(updated).toMatchObject({
      kind: "worker",
      name: "New Planner",
      handle: "planner",
      description: "Plans the work",
      instructions: "Keep replies short.",
      harness: "opencode",
      reasoningEffort: "max",
    });
    expect(updated).not.toHaveProperty("model");
    expect(store.findAgentByHandle("old-planner")).toBeUndefined();
    await expect(store.updateAgent(agent.id, { handle: "reserved" })).rejects.toMatchObject({
      code: "conflict",
    });
    const restored = await store.updateAgent(agent.id, { model: "gpt-test" });
    expect(restored).toMatchObject({ kind: "worker", model: "gpt-test" });
  });
  it("keeps, rotates, and removes a custom Master credential without leaking secrets", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat" as const,
        apiKey: "sk-original",
      },
    });
    const providerFields = {
      type: "custom" as const,
      name: "Gateway",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      protocol: "openai-chat" as const,
    };
    const kept = await store.updateAgent(agent.id, { provider: providerFields });
    if (kept.kind !== "master") throw new Error("expected master");
    expect(kept.provider).toMatchObject({ type: "custom", hasCredential: true });
    expect(store.getCredential(agent.id)).toBe("sk-original");
    const rotated = await store.updateAgent(agent.id, {
      provider: { ...providerFields, apiKey: "sk-rotated" },
    });
    if (rotated.kind !== "master") throw new Error("expected master");
    expect(rotated.provider).toMatchObject({ hasCredential: true });
    expect(store.getCredential(agent.id)).toBe("sk-rotated");
    const removed = await store.updateAgent(agent.id, {
      provider: { ...providerFields, removeCredential: true },
    });
    if (removed.kind !== "master") throw new Error("expected master");
    expect(removed.provider).toMatchObject({ hasCredential: false });
    expect(store.getCredential(agent.id)).toBeUndefined();
    const stateText = await readFile(store.stateFile, "utf8");
    const credentialText = await readFile(store.credentialFile, "utf8");
    expect(stateText).not.toContain("sk-");
    expect(credentialText).not.toContain("sk-rotated");
  });
  it("rolls back a credential rotation when the state write fails", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat" as const,
        apiKey: "sk-original",
      },
    });
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(
        store.updateAgent(agent.id, {
          provider: {
            type: "custom" as const,
            name: "Gateway",
            baseUrl: "https://gateway.example/v1",
            model: "model-a",
            protocol: "openai-chat" as const,
            apiKey: "sk-new-rotated",
          },
        }),
      ).rejects.toThrow("simulated state write failure");
      expect(store.getCredential(agent.id)).toBe("sk-original");
      expect(await readFile(store.credentialFile, "utf8")).toContain("sk-original");
      expect(await readFile(store.credentialFile, "utf8")).not.toContain("sk-new-rotated");
      expect(await readFile(store.stateFile, "utf8")).not.toContain("sk-new-rotated");
    } finally {
      internal.writeState = writeState;
    }
  });
  it("rejects configuration fields that do not match the agent kind", async () => {
    const store = await openStore();
    const master = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    await expect(store.updateAgent(master.id, { harness: "codex" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("marks interrupted repository clones failed at startup without changing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-store-clone-recovery-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "provenance-source");
    const gitLike = await store.createKnowledgeRepository({
      name: "Interrupted complete clone",
      handle: "interrupted-complete",
      description: "",
      source,
    });
    await mkdir(join(store.knowledgePath(gitLike), ".git"), { recursive: true });
    const missing = await store.createKnowledgeRepository({
      name: "Interrupted early clone",
      handle: "interrupted-early",
      description: "",
      source: join(root, "missing-source"),
    });
    const itemRoot = dirname(store.knowledgePath(gitLike));
    await mkdir(join(itemRoot, "source.retrying-crash", ".git"), { recursive: true });

    const reopened = await FileStore.open({ root, workspacePath: root });
    const gitLikeRecovered = reopened.getKnowledge(gitLike.id);
    const missingRecovered = reopened.getKnowledge(missing.id);
    if (gitLikeRecovered?.kind !== "repository" || missingRecovered?.kind !== "repository") {
      throw new Error("expected repository knowledge");
    }
    expect(gitLikeRecovered).toMatchObject({
      id: gitLike.id,
      handle: "interrupted-complete",
      source,
      status: "failed",
      createdAt: gitLike.createdAt,
    });
    expect(gitLikeRecovered.error).toMatch(/existing git clone/);
    expect(missingRecovered).toMatchObject({ status: "failed", createdAt: missing.createdAt });
    expect(missingRecovered.error).toMatch(/server restart/);
    expect(await readdir(itemRoot)).toEqual(
      expect.arrayContaining(["source", "source.retrying-crash"]),
    );
    await expect(readdir(join(itemRoot, "source.retrying-crash", ".git"))).resolves.toEqual([]);
  });

  it("rejects knowledge edits while a repository clone is still running", async () => {
    const store = await openStore();
    const repository = await store.createKnowledgeRepository({
      name: "Cloning repository",
      handle: "cloning-repo",
      description: "",
      source: join(store.workspacePath, "source"),
    });
    await expect(
      store.updateKnowledge(repository.id, { name: "Renamed while cloning" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.updateKnowledgeRepository(repository.id, { status: "failed", error: "stopped" });
    await expect(
      store.updateKnowledge(repository.id, { name: "Renamed after retry failed" }),
    ).resolves.toMatchObject({ name: "Renamed after retry failed" });
  });

  it("rolls back interrupted clone recovery when the state write fails", async () => {
    const store = await openStore();
    const repository = await store.createKnowledgeRepository({
      name: "Cloning repository",
      handle: "cloning-rollback",
      description: "",
      source: join(store.workspacePath, "missing-source"),
    });
    const internal = store as unknown as {
      recoverInterruptedRepositories: () => Promise<void>;
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(internal.recoverInterruptedRepositories()).rejects.toThrow(
        "simulated state write failure",
      );
    } finally {
      internal.writeState = writeState;
    }
    expect(store.getKnowledge(repository.id)).toMatchObject({ status: "cloning" });
    expect(store.getKnowledge(repository.id)).not.toHaveProperty("error");
  });
});

describe("FileStore transcript search", () => {
  it("searches active and archived messages, keeps rename identity, and honors filters", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected default workspace");
    const general = store.listThreads(workspace.id)[0];
    if (!general) throw new Error("expected general thread");
    const generalMessage = await store.createUserMessage(general.id, "alpha phrase in general", []);
    await store.renameThread(general.id, { name: "Research Log" });
    await store.archiveThread(general.id);
    const activeThread = await store.createThread({ name: "Active Notes" });
    const activeMessage = await store.createUserMessage(activeThread.id, "alpha phrase active", []);

    const all = await store.searchMessages({ workspaceId: workspace.id, q: "alpha phrase" });
    expect(all.complete).toBe(true);
    expect(all.matchesFound).toBe(2);
    expect(all.matches.map((hit) => hit.messageId).sort()).toEqual(
      [generalMessage.id, activeMessage.id].sort(),
    );
    expect(all.matches.find((hit) => hit.thread.id === general.id)).toMatchObject({
      messageId: generalMessage.id,
      thread: { id: general.id, name: "Research Log", archived: true },
    });

    const active = await store.searchMessages({
      workspaceId: workspace.id,
      q: "alpha",
      archived: "active",
    });
    expect(active.matches).toHaveLength(1);
    expect(active.matches[0]?.thread.id).toBe(activeThread.id);

    const archived = await store.searchMessages({
      workspaceId: workspace.id,
      q: "alpha",
      archived: "archived",
    });
    expect(archived.matches).toHaveLength(1);
    expect(archived.matches[0]?.thread.id).toBe(general.id);

    const scoped = await store.searchMessages({
      workspaceId: workspace.id,
      q: "alpha",
      threadId: general.id,
    });
    expect(scoped.matches).toHaveLength(1);
    expect(scoped.matches[0]?.thread.id).toBe(general.id);
    for (const hit of all.matches) expect(hit).not.toHaveProperty("content");
  });

  it("isolates workspaces and rejects foreign thread filters", async () => {
    const store = await openStore();
    const [first] = store.listWorkspaces();
    if (!first) throw new Error("expected workspace");
    const second = await store.createWorkspace({ name: "Second" });
    const firstThread = store.listThreads(first.id)[0];
    const secondThread = store.listThreads(second.id)[0];
    if (!firstThread || !secondThread) throw new Error("expected threads");
    const firstMessage = await store.createUserMessage(firstThread.id, "same needle", []);
    await store.createUserMessage(secondThread.id, "same needle", []);

    const result = await store.searchMessages({ workspaceId: first.id, q: "needle" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.messageId).toBe(firstMessage.id);

    await expect(
      store.searchMessages({ workspaceId: first.id, q: "needle", threadId: secondThread.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("matches case-insensitively and returns bounded context snippets", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const content =
      "Start " +
      "padding text ".repeat(80) +
      "The Phrase In Question lives here." +
      " trailing ".repeat(80) +
      "End";
    const message = await store.createUserMessage(thread.id, content, []);
    const result = await store.searchMessages({ workspaceId: workspace.id, q: "pHRASE iN" });

    expect(result.complete).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.messageId).toBe(message.id);
    expect(result.matches[0]?.snippet.toLowerCase()).toContain("phrase in");
    expect(result.matches[0]?.snippet.length).toBeLessThanOrEqual(300);
    expect(result.matches[0]?.snippet).toContain("\u2026");
  });

  it("counts malformed, oversized, and torn lines as partial without hiding valid matches", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const message = await store.createUserMessage(thread.id, "valid needle", []);
    const file = store.transcriptPath(thread.id);
    await appendFile(file, "{definitely not json}\n");
    await appendFile(file, `${"x".repeat(1_100_000)}\n`);
    await appendFile(file, '{"sequence":999,"type":"run.updated"');

    const result = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(result.complete).toBe(false);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.messageId).toBe(message.id);
    expect(result.diagnostics).toMatchObject({
      malformedLines: 1,
      oversizedLines: 1,
      tornTailLines: 1,
      scanLimited: false,
    });
  });

  it("reports partial scans without pagination and pages only complete scans", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    for (let index = 0; index < 3; index += 1) {
      await store.createUserMessage(thread.id, `hit ${index}`, []);
    }

    const partial = await store.searchMessages(
      { workspaceId: workspace.id, q: "hit" },
      { maxScanLines: 1 },
    );
    expect(partial.complete).toBe(false);
    expect(partial.diagnostics.scanLimited).toBe(true);
    expect(partial.diagnostics.scanLimit).toBe("lines");
    expect(partial.matchesFound).toBeLessThan(3);
    expect(partial.nextOffset).toBeNull();

    const bytesPartial = await store.searchMessages(
      { workspaceId: workspace.id, q: "hit" },
      { maxScanBytes: 40 },
    );
    expect(bytesPartial.complete).toBe(false);
    expect(bytesPartial.diagnostics.scanLimit).toBe("bytes");
    expect(bytesPartial.nextOffset).toBeNull();

    const first = await store.searchMessages({ workspaceId: workspace.id, q: "hit", limit: 2 });
    expect(first.complete).toBe(true);
    expect(first.matches).toHaveLength(2);
    expect(first.matchesFound).toBe(3);
    expect(first.nextOffset).toBe(2);

    const second = await store.searchMessages({
      workspaceId: workspace.id,
      q: "hit",
      limit: 2,
      offset: 2,
    });
    expect(second.complete).toBe(true);
    expect(second.matches).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
  });

  it("keeps searches complete for never-used threads that have no transcript yet", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    await store.createThread({ name: "Unused" });
    const result = await store.searchMessages({ workspaceId: workspace.id, q: "anything" });
    expect(result.complete).toBe(true);
    expect(result.diagnostics.missingFiles).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("reports missing and unreadable transcripts as partial without leaking paths", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const alpha = store.listThreads(workspace.id)[0];
    if (!alpha) throw new Error("expected thread");
    const beta = await store.createThread({ name: "Beta" });
    const alphaMessage = await store.createUserMessage(alpha.id, "needle alpha", []);
    const betaMessage = await store.createUserMessage(beta.id, "needle beta", []);
    await rm(store.transcriptPath(alpha.id));

    const missing = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(missing.complete).toBe(false);
    expect(missing.diagnostics.missingFiles).toBe(1);
    expect(missing.diagnostics.scanLimit).toBe("missing_file");
    expect(missing.matches.some((hit) => hit.messageId === alphaMessage.id)).toBe(false);
    expect(missing.matches.map((hit) => hit.thread.id)).toContain(beta.id);
    expect(JSON.stringify(missing)).not.toContain(store.root);

    const unreadableStore = await openStore();
    const [secondWorkspace] = unreadableStore.listWorkspaces();
    if (!secondWorkspace) throw new Error("expected workspace");
    const unreadableThread = unreadableStore.listThreads(secondWorkspace.id)[0];
    if (!unreadableThread) throw new Error("expected thread");
    await unreadableStore.createUserMessage(unreadableThread.id, "needle", []);
    await rm(unreadableStore.transcriptPath(unreadableThread.id));
    await mkdir(unreadableStore.transcriptPath(unreadableThread.id));

    const unreadable = await unreadableStore.searchMessages({
      workspaceId: secondWorkspace.id,
      q: "needle",
    });
    expect(unreadable.complete).toBe(false);
    expect(unreadable.diagnostics.unreadableFiles).toBe(1);
    expect(unreadable.diagnostics.scanLimit).toBe("unreadable_file");
    expect(JSON.stringify(unreadable)).not.toContain(unreadableStore.root);
    expect(betaMessage.id).toBeTruthy();
  });

  it("keeps transcripts and state bytes unchanged across searches", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    await store.createUserMessage(thread.id, "needle before", []);
    await appendFile(store.transcriptPath(thread.id), "{malformed}\n");
    const transcriptBefore = await readFile(store.transcriptPath(thread.id));
    const stateBefore = await readFile(store.stateFile);

    await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    await store.searchMessages({ workspaceId: workspace.id, q: "malformed" });

    expect(await readFile(store.transcriptPath(thread.id))).toEqual(transcriptBefore);
    expect(await readFile(store.stateFile)).toEqual(stateBefore);
  });

  it("redacts credentials from query echo, snippets, and response metadata", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const secret = "fixture-hello-world";
    const agent = await store.createAgent({
      kind: "master",
      name: `${secret} bot`,
      handle: "secret-bot",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Secret Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    await store.renameThread(thread.id, { name: `${secret} notes` });
    await store.createUserMessage(thread.id, `the ${secret} lives near needle`, []);
    const trigger = await store.createUserMessage(thread.id, "trigger", []);
    await store.createAgentMessage(thread.id, agent, "needle reply", trigger.id);

    const byNeedle = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(byNeedle.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(byNeedle)).not.toContain(secret);

    const bySecret = await store.searchMessages({ workspaceId: workspace.id, q: secret });
    expect(bySecret.matchesFound).toBe(0);
    expect(bySecret.query.term).not.toContain(secret);
    expect(bySecret.query.term).toBe("[REDACTED]");
    expect(JSON.stringify(bySecret)).not.toContain(secret);
  });

  it("clips redacted query echo when redaction expands past the max", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const secret = "abcdefgh";
    await store.createAgent({
      kind: "master",
      name: "Clip",
      handle: "clip",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Clip Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const result = await store.searchMessages({
      workspaceId: workspace.id,
      q: secret.repeat(21),
    });
    expect(result.query.term.length).toBe(200);
    expect(result.query.term).not.toContain(secret);
  });

  it("redacts an agent handle that coincides with a stored credential without failing", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const secret = "abcdefgh";
    const agent = await store.createAgent({
      kind: "master",
      name: "Handle Overlap",
      handle: secret,
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Overlap Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const trigger = await store.createUserMessage(thread.id, "trigger", []);
    const reply = await store.createAgentMessage(thread.id, agent, "needle handle", trigger.id);

    const result = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(result.complete).toBe(true);
    const hit = result.matches.find((entry) => entry.messageId === reply.id);
    expect(hit?.author).toMatchObject({ kind: "agent", handle: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("marks partial when hits carry unusable metadata instead of failing the scan", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const good = await store.createUserMessage(thread.id, "needle good", []);
    const now = "2026-01-01T00:00:00.000Z";
    const badTime = {
      id: "bad-time",
      threadId: thread.id,
      sequence: 2,
      author: { kind: "user" as const, id: "local-user" as const, name: "You" },
      content: "needle bad time",
      mentions: [],
      knowledgeReferences: [],
      artifactIds: [],
      createdAt: "not-a-timestamp",
    };
    const bigName = {
      id: "big-name",
      threadId: thread.id,
      sequence: 3,
      author: {
        kind: "agent" as const,
        id: "big-agent",
        name: "n".repeat(600),
        handle: "big-agent",
      },
      content: "needle big name",
      mentions: [],
      knowledgeReferences: [],
      artifactIds: [],
      createdAt: now,
    };
    await appendFile(
      store.transcriptPath(thread.id),
      JSON.stringify({ type: "message.created", sequence: 2, message: badTime }) +
        "\n" +
        JSON.stringify({ type: "message.created", sequence: 3, message: bigName }) +
        "\n",
    );

    const result = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(result.complete).toBe(false);
    expect(result.matches.map((hit) => hit.messageId)).toContain(good.id);
    expect(result.matches.some((hit) => hit.messageId === "bad-time")).toBe(false);
    expect(result.matches.some((hit) => hit.messageId === "big-name")).toBe(false);
  });

  it("never returns a nextOffset beyond the accepted request cap", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const count = 10_150;
    const lines: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      lines.push(
        JSON.stringify({
          type: "message.created",
          sequence: index,
          message: {
            id: `raw-${String(index).padStart(5, "0")}`,
            threadId: thread.id,
            sequence: index,
            author: { kind: "user", id: "local-user", name: "Bulk" },
            content: "match needle",
            mentions: [],
            knowledgeReferences: [],
            artifactIds: [],
            createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
          },
        }),
      );
    }
    await writeFile(store.transcriptPath(thread.id), `${lines.join("\n")}\n`);

    const nearCap = await store.searchMessages({
      workspaceId: workspace.id,
      q: "needle",
      limit: 100,
      offset: 9_900,
    });
    expect(nearCap.complete).toBe(true);
    expect(nearCap.matches).toHaveLength(100);
    expect(nearCap.matchesFound).toBe(count);
    expect(nearCap.nextOffset).toBe(10_000);

    const atCap = await store.searchMessages({
      workspaceId: workspace.id,
      q: "needle",
      limit: 100,
      offset: 10_000,
    });
    expect(atCap.complete).toBe(true);
    expect(atCap.matches).toHaveLength(100);
    expect(atCap.matchesFound).toBe(count);
    expect(atCap.nextOffset).toBeNull();
  });

  it("treats invalid UTF-8 transcript lines as malformed while preserving valid Unicode and CRLF lines", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const good = await store.createUserMessage(thread.id, "needle with Unicode ☃", []);
    const invalidLine = Buffer.concat([
      Buffer.from(
        '{"type":"message.created","sequence":2,"message":{"id":"bad-utf8","threadId":"' +
          thread.id +
          '","sequence":2,"author":{"kind":"user","id":"local-user","name":"You"},' +
          '"content":"valid needle ',
      ),
      Buffer.from([0xff]),
      Buffer.from(
        '","mentions":[],"knowledgeReferences":[],"artifactIds":[],"createdAt":"2026-01-01T00:00:00.000Z"}}\n',
      ),
    ]);
    const crlfLine =
      '{"type":"message.created","sequence":3,"message":{"id":"crlf-line","threadId":"' +
      thread.id +
      '","sequence":3,"author":{"kind":"user","id":"local-user","name":"You"},' +
      '"content":"needle crlf","mentions":[],"knowledgeReferences":[],"artifactIds":[],' +
      '"createdAt":"2026-01-01T00:00:01.000Z"}}\r\n';
    await appendFile(store.transcriptPath(thread.id), invalidLine);
    await appendFile(store.transcriptPath(thread.id), crlfLine);

    const result = await store.searchMessages({ workspaceId: workspace.id, q: "needle" });
    expect(result.complete).toBe(false);
    expect(result.diagnostics.malformedLines).toBe(1);
    expect(result.matches.map((hit) => hit.messageId)).toEqual(
      expect.arrayContaining([good.id, "crlf-line"]),
    );
    expect(result.matches.some((hit) => hit.messageId === "bad-utf8")).toBe(false);
  });
});
