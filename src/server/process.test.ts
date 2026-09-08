import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import utf8Fixtures from "./fixtures/process-utf8.json";
import { runCommand } from "./process.js";

describe("runCommand", () => {
  it("forwards stdout chunks before the process exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-stream-"));
    const chunks: string[] = [];

    const result = await runCommand(
      "/bin/sh",
      ["-c", "printf first; sleep 0.02; printf ' second'"],
      { cwd, onStdout: (chunk) => chunks.push(chunk) },
    );

    expect(chunks.join("")).toBe("first second");
    expect(result.stdout).toBe("first second");
  });

  it.each(utf8Fixtures)("preserves $name", async (fixture) => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-utf8-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const script = `
      const writes = ${JSON.stringify(fixture.writes)};
      for (const { stream, hex } of writes) {
        process[stream].write(Buffer.from(hex, "hex"));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    `;

    const result = await runCommand(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });

    expect(result).toEqual({ stdout: fixture.stdout, stderr: fixture.stderr, exitCode: 0 });
    expect(stdout.join("")).toBe(fixture.stdout);
    expect(stderr.join("")).toBe(fixture.stderr);
    expect(stdout).not.toContain("");
    expect(stderr).not.toContain("");
  });

  it("enforces the combined raw byte limit for multibyte output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-bytes-"));

    await expect(
      runCommand(process.execPath, ["-e", 'process.stdout.write("€"); process.stderr.write("€")'], {
        cwd,
        maxOutputBytes: 5,
      }),
    ).rejects.toThrow("too much data");
  });

  it("rejects when a callback cannot process an incomplete final character", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-final-"));

    await expect(
      runCommand(process.execPath, ["-e", 'process.stdout.write(Buffer.from("e282", "hex"))'], {
        cwd,
        onStdout: () => {
          throw new Error("Cannot consume output.");
        },
      }),
    ).rejects.toThrow("Cannot consume output.");
  });

  it("escalates from TERM to KILL before rejecting a timed-out process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-"));

    await expect(
      runCommand("/bin/sh", ["-c", "trap '' TERM; while true; do :; done"], {
        cwd,
        timeoutMs: 40,
        terminationGraceMs: 60,
      }),
    ).rejects.toThrow("timed out");
  });

  it("terminates the process group when the caller aborts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-abort-"));
    const controller = new AbortController();
    const command = runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd,
      timeoutMs: 5_000,
      terminationGraceMs: 50,
      signal: controller.signal,
    });

    controller.abort(new Error("Stopped by the user."));

    await expect(command).rejects.toThrow("Stopped by the user.");
  });
});
