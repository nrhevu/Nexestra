import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOptions } from "./options.js";
import { OpenCodeServerManager, parseServerUrl } from "./server.js";
import { FAKE_OPENCODE_SCRIPT, FakeOpenCodeServer } from "./test-support.js";

let root: string;
let binary: string;
let workspace: string;
let logFile: string;
let childPidFile: string;
const managers: OpenCodeServerManager[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-opencode-server-"));
  binary = path.join(root, "opencode");
  workspace = path.join(root, "repo");
  logFile = path.join(root, "fake.log");
  childPidFile = path.join(root, "child.pid");
  await writeFile(binary, FAKE_OPENCODE_SCRIPT, "utf8");
  await chmod(binary, 0o755);
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll().catch(() => {})));
  await rm(root, { recursive: true, force: true });
});

function manager(env: Record<string, string> = {}, overrides = {}) {
  const created = new OpenCodeServerManager({
    binary: async () => binary,
    options: resolveOptions({
      binaryPath: binary,
      env: { FAKE_LOG: logFile, ...env },
      startTimeoutMs: 10_000,
      killGraceMs: 1000,
      ...overrides,
    }),
  });
  managers.push(created);
  return created;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("parseServerUrl", () => {
  it("reads the line opencode prints on stderr", () => {
    expect(parseServerUrl("opencode server listening on http://127.0.0.1:4791\n")).toBe(
      "http://127.0.0.1:4791",
    );
  });

  it("falls back to a bare loopback URL and trims punctuation", () => {
    expect(parseServerUrl("ready at http://127.0.0.1:5000.")).toBe("http://127.0.0.1:5000");
    expect(parseServerUrl("nothing here")).toBeUndefined();
  });
});

describe("OpenCodeServerManager", () => {
  it("starts a server per workspace and parses the port from the log line", async () => {
    const servers = manager();
    const server = await servers.ensure(workspace);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.version).toBe("1.18.25");
    expect(server.alive()).toBe(true);
    const argv = JSON.parse((await readFile(logFile, "utf8")).trim()) as string[];
    expect(argv).toEqual([
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--print-logs",
      "--log-level",
      "INFO",
      "--pure",
    ]);
  });

  it("reuses the same server for the same directory", async () => {
    const servers = manager();
    const first = await servers.ensure(workspace);
    const second = await servers.ensure(workspace);
    expect(second).toBe(first);
    expect(servers.servers.size).toBe(1);
  });

  it("serialises concurrent starts into one process", async () => {
    const servers = manager();
    const [a, b, c] = await Promise.all([
      servers.ensure(workspace),
      servers.ensure(workspace),
      servers.ensure(workspace),
    ]);
    expect(a.pid).toBe(b.pid);
    expect(b.pid).toBe(c.pid);
  });

  it("restarts a server whose process died", async () => {
    const servers = manager({ FAKE_CRASH_AFTER_MS: "150" });
    const first = await servers.ensure(workspace);
    expect(await waitFor(() => !first.alive())).toBe(true);
    const second = await servers.ensure(workspace);
    expect(second.pid).not.toBe(first.pid);
    expect(second.alive()).toBe(true);
  });

  it("notifies listeners when the process exits", async () => {
    const servers = manager({ FAKE_CRASH_AFTER_MS: "150" });
    const server = await servers.ensure(workspace);
    let reason: string | undefined;
    server.onExit((value) => {
      reason = value;
    });
    expect(await waitFor(() => reason !== undefined)).toBe(true);
    expect(reason).toContain("exit code 7");
  });

  it("fails cleanly when the server never prints a URL", async () => {
    const servers = manager({ FAKE_MODE: "no-listen" }, { startTimeoutMs: 700 });
    await expect(servers.ensure(workspace)).rejects.toThrow(/did not report a listening URL/);
    expect(servers.servers.size).toBe(0);
  });

  it("fails cleanly when the server never becomes healthy", async () => {
    const servers = manager({ FAKE_MODE: "unhealthy" }, { startTimeoutMs: 800 });
    await expect(servers.ensure(workspace)).rejects.toThrow(/never became healthy/);
  });

  it("kills the whole process group on dispose", async () => {
    const servers = manager({ FAKE_CHILD_PID_FILE: childPidFile });
    const server = await servers.ensure(workspace);
    const pid = server.pid;
    expect(pid).toBeDefined();
    expect(await waitFor(() => existsSync(childPidFile))).toBe(true);
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(alive(childPid)).toBe(true);

    await servers.dispose(workspace);
    expect(await waitFor(() => !alive(pid ?? 0))).toBe(true);
    // The model's shell commands are children of the server; a plain kill would
    // orphan them, so the group has to go.
    expect(await waitFor(() => !alive(childPid))).toBe(true);
    expect(servers.servers.size).toBe(0);
  });

  it("refuses to hand out servers after disposeAll", async () => {
    const servers = manager();
    await servers.ensure(workspace);
    await servers.disposeAll();
    await expect(servers.ensure(workspace)).rejects.toThrow(/disposed/);
  });

  it("attaches to an external server without spawning or disposing it", async () => {
    const external = new FakeOpenCodeServer({ version: "1.18.30" });
    const url = await external.start();
    try {
      const servers = manager({}, { attachUrl: url });
      const server = await servers.ensure(workspace);
      expect(server.external).toBe(true);
      expect(server.pid).toBeUndefined();
      expect(server.version).toBe("1.18.30");
      await servers.disposeAll();
      // Nothing we did not start may be disposed.
      expect(external.requests.some((request) => request.url.startsWith("/instance/dispose"))).toBe(
        false,
      );
    } finally {
      await external.stop();
    }
  });
});
