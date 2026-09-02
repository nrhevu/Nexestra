/**
 * What the simulated harness "does".
 *
 * `createFakeHarnessAdapter()` ships with a default script that emits a
 * successful run and writes nothing. That is right for a unit test and wrong
 * for a demo: a task that changes no file produces an empty `git diff`, no
 * commit, and an Editor surface with nothing in it.
 *
 * So the demo script writes one real Markdown file per task into the worktree.
 * The diff is real, the commit is real, the file tree in the Editor is real,
 * and the verification commands from the spec run against a tree that actually
 * changed — everything downstream of the harness is exercised for real. Only
 * the model is missing.
 */

import type { FakeRunContext, FakeRunScript } from "@nexestra/adapter-fake";
import type { HarnessEvent } from "@nexestra/core";

/** Directory the simulated harness writes into, relative to the worktree. */
export const DEMO_OUTPUT_DIR = "nexestra-demo";

export function createDemoHarnessScript(
  harnessId: string,
): (context: FakeRunContext) => FakeRunScript {
  return ({ spec, attempt }) => {
    if (spec.kind === "review") {
      return {
        delayMs: 40,
        events: [
          { type: "started", sessionRef: `${harnessId}-review-${spec.taskId}` },
          {
            type: "assistant_text",
            text: `Reviewing the uncommitted diff for ${spec.taskId}…`,
          },
          {
            type: "command",
            cmd: "git diff --stat",
            exitCode: 0,
            stdout: ` ${DEMO_OUTPUT_DIR}/${spec.taskId}.md | 8 ++++++++\n`,
          },
          { type: "usage", inputTokens: 900, outputTokens: 120 },
          {
            type: "final",
            message: "No blocking findings.",
            structured: { summary: "The change is small and self-contained.", findings: [] },
          },
          { type: "ended", exitCode: 0 },
        ],
      };
    }

    const file = `${DEMO_OUTPUT_DIR}/${spec.taskId}.md`;
    const body = [
      `# ${spec.taskId}`,
      "",
      `Written by the simulated \`${harnessId}\` harness, attempt ${attempt}.`,
      "",
      "## Instructions it was given",
      "",
      "```",
      spec.instructions.slice(0, 1200),
      "```",
      "",
    ].join("\n");

    const events: HarnessEvent[] = [
      { type: "started", sessionRef: `${harnessId}-${spec.taskId}-${attempt}` },
      { type: "assistant_text", text: `Reading the task and the acceptance criteria…` },
      {
        type: "tool_call",
        name: "write_file",
        callId: `call_${spec.taskId}_${attempt}`,
        input: { path: file },
      },
      {
        type: "tool_result",
        callId: `call_${spec.taskId}_${attempt}`,
        ok: true,
        output: `wrote ${file}`,
      },
      { type: "file_changed", path: file, kind: "add" },
      {
        type: "command",
        cmd: `git status --short`,
        exitCode: 0,
        stdout: `?? ${file}\n`,
      },
      { type: "usage", inputTokens: 3200, outputTokens: 640 },
      { type: "assistant_text", text: `Wrote ${file}.` },
      { type: "final", message: `Wrote ${file} for ${spec.taskId}.` },
      { type: "ended", exitCode: 0 },
    ];

    return { files: { [file]: body }, events, delayMs: 60 };
  };
}
