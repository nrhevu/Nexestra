import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("escalates from TERM to KILL before rejecting a timed-out process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexestra-process-"));
    const startedAt = Date.now();

    let receivedTerm = false;
    await expect(
      runCommand("/bin/sh", ["-c", "trap 'printf TERM' TERM; printf READY; while :; do :; done"], {
        cwd,
        timeoutMs: 200,
        terminationGraceMs: 60,
        onStdout: (chunk) => {
          if (chunk.includes("TERM")) receivedTerm = true;
        },
      }),
    ).rejects.toThrow("timed out");
    expect(receivedTerm).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
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
