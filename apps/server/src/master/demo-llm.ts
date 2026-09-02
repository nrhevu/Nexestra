/**
 * `DemoLlmClient` — a deterministic stand-in for Opus 5.
 *
 * Nexestra is local-first and most people will open it before they have an
 * `ANTHROPIC_API_KEY` on the machine. Without a model the Chat surface would
 * be a dead box, so the server falls back to this: a scripted "model" that
 * plays the M2/M3 happy path — read the workspace, ask three clarifying
 * questions, draft a spec with three verifiable acceptance criteria, request
 * approval, then propose a four-task plan with dependencies.
 *
 * It is a real `LlmClient`, not a shortcut around the Master: every step goes
 * through the same phase machine, the same strict tool validation and the same
 * store writes as the live client. What it is not is intelligent — it derives
 * its content from the user's first message and their answers, and it decides
 * what to do next by looking at the phase and at which tools it has already
 * called.
 *
 * Deliberately no randomness and no clock: the same conversation always
 * produces the same run, which is what makes it usable in a test and
 * unsurprising in a demo.
 */
import type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmMessageParam,
  LlmRequest,
  LlmStreamEvent,
} from "@nexestra/master";

export const DEMO_MODEL = "nexestra-demo-master";

export interface DemoLlmClientOptions {
  /** Pause between streamed text chunks, so the UI visibly streams. */
  readonly chunkDelayMs?: number;
}

interface DemoTurn {
  readonly text: string;
  readonly toolUse?: { readonly name: string; readonly input: unknown };
}

const DEFAULT_CRITERIA = ["ac_tests", "ac_build", "ac_docs"] as const;

export function createDemoLlmClient(options: DemoLlmClientOptions = {}): LlmClient {
  const chunkDelayMs = options.chunkDelayMs ?? 25;
  let callCount = 0;

  async function* stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    callCount += 1;
    const turn = decide(request);

    for (const chunk of chunks(turn.text)) {
      yield { type: "text_delta", text: chunk };
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
    }

    const content: LlmContentBlock[] = [{ type: "text", text: turn.text, citations: null }];
    if (turn.toolUse) {
      content.push({
        type: "tool_use",
        id: `demo_call_${callCount}`,
        name: turn.toolUse.name,
        input: turn.toolUse.input,
      });
    }

    yield { type: "message", message: messageOf(content, turn.toolUse !== undefined, callCount) };
  }

  return { model: DEMO_MODEL, stream };
}

/* ------------------------------------------------------------- the "model" */

/**
 * The whole policy: current phase plus which tools the transcript already
 * shows. Because the Master re-sends the full history on every call, this is
 * enough to know where in the script we are without any hidden state.
 */
function decide(request: LlmRequest): DemoTurn {
  const phase = phaseOf(request.systemSuffix ?? "");
  const used = toolsUsed(request.messages);
  const goal = firstUserText(request.messages);
  const answers = answersGiven(request.messages);
  const open = openQuestionIds(request.systemSuffix ?? "");
  const criteria = criterionIds(request.systemSuffix ?? "");
  const calls = toolUseCounts(request.messages);

  switch (phase) {
    case "intake":
      if (!used.has("read_workspace")) {
        return {
          text: "Let me look at the workspace before I ask you anything.",
          toolUse: {
            name: "read_workspace",
            input: { depth: 2, includeManifests: true },
          },
        };
      }
      if (used.has("ask_user")) {
        // The call was made and did not suspend the turn, which only happens
        // when it was rejected. Stop rather than retry the same input.
        return { text: "I could not put those questions to you. Tell me what you need instead." };
      }
      return {
        text:
          "I have the lay of the repository. Three things would let me write a spec " +
          "I can hold myself to:",
        toolUse: { name: "ask_user", input: questionsFor(goal) },
      };

    case "clarifying":
      if (!used.has("update_spec")) {
        return {
          text: "That is enough to draft the spec.",
          toolUse: { name: "update_spec", input: specPatch(goal, answers, open) },
        };
      }
      if (!used.has("request_approval")) {
        return {
          text:
            "The spec has a goal, an explicit scope, and three acceptance criteria that " +
            "can each fail. Approve it and I will turn it into a plan.",
          toolUse: {
            name: "request_approval",
            input: {
              kind: "spec",
              summary: `Freeze the spec for: ${goal}`,
              payload: {
                detail:
                  "Approving freezes this version of the spec and moves the thread into " +
                  "planning. Rejecting keeps it open for more clarification.",
                risk: "low",
              },
            },
          },
        };
      }
      return { text: "Waiting on your decision about the spec." };

    case "spec_frozen":
      if (!used.has("summarize")) {
        return {
          text: "Spec frozen. Recording where we are before I plan the work.",
          toolUse: {
            name: "summarize",
            input: {
              outcome: "progress",
              summary: `Spec approved for: ${goal}. Moving on to the plan.`,
            },
          },
        };
      }
      return { text: "Ready to plan." };

    case "planning":
      if (!used.has("propose_plan")) {
        return {
          text: "Here is how I would split the work.",
          toolUse: { name: "propose_plan", input: planFor(goal, criteria) },
        };
      }
      return {
        text:
          "The plan is on the Task Board: four tasks, wired so nothing starts before " +
          "what it depends on is done. Running them needs the harness orchestrator, " +
          "which is not wired up in this build yet.",
      };

    // From M6 the orchestrator drives these three phases; the demo model's job
    // is to leave a readable trace and to record what was learned, not to
    // second-guess a loop that has already run the acceptance criteria.
    case "executing":
      if ((calls.get("record_memory") ?? 0) < 1) {
        return {
          text: "Execution is under way. Noting the decision so it survives the thread.",
          toolUse: {
            name: "record_memory",
            input: {
              type: "decision",
              title: "Plan handed to the orchestrator",
              content:
                `The four tasks for "${goal}" are being dispatched to the harnesses in ` +
                "dependency order. Failures come back here as a replan request.",
            },
          },
        };
      }
      return {
        text:
          "The orchestrator is running the plan. Watch the Task Board for status and the " +
          "Editor for the diff; anything that needs a decision arrives as an approval.",
      };

    case "verifying":
      return {
        text:
          "Every task has finished. The acceptance criteria were run in each worktree and " +
          "their evidence is on the spec — a criterion that still has none needs its " +
          "verification command run, or a manual review approved.",
      };

    case "done":
      if ((calls.get("summarize") ?? 0) < 2) {
        return {
          text: "Everything is verified. Writing the summary.",
          toolUse: {
            name: "summarize",
            input: {
              outcome: "done",
              summary:
                `Delivered: ${goal}. Every task reached done and every acceptance ` +
                "criterion carries evidence produced by running it.",
              lessons: [
                "Acceptance criteria that name a command can be proved automatically; " +
                  "the ones that say `manual_review` always stop the loop for a human.",
                "Splitting the work so each task owns one criterion keeps the retry " +
                  "loop narrow when a task fails.",
              ],
            },
          },
        };
      }
      return { text: "Done. The thread summary and its lessons are in the memory graph." };

    default:
      return {
        text: `Nothing further to do in the \`${phase}\` phase with the demo model.`,
      };
  }
}

/* ------------------------------------------------------------ tool payloads */

/** An `ask_user` input: the whole `{questions: [...]}` object. */
function questionsFor(goal: string): unknown {
  return {
    questions: [
      {
        id: "q_outcome",
        text: `What does "done" look like for "${goal}"? Name the smallest version you would ship.`,
        options: [
          "A working end-to-end path, rough edges allowed",
          "A polished feature with tests and docs",
          "A spike I can throw away",
        ],
        allowFreeText: true,
      },
      {
        id: "q_scope",
        text: "Which part of this workspace should change, and what must stay untouched?",
        options: [
          "Anywhere the change needs to reach",
          "Only new files; leave existing modules alone",
          "One package / directory only",
        ],
        allowFreeText: true,
      },
      {
        id: "q_proof",
        text: "How should I prove it works before calling it done?",
        options: [
          "The existing test command has to pass",
          "A new automated test covering this specifically",
          "You will review it by hand",
        ],
        allowFreeText: true,
      },
    ],
  };
}

function specPatch(
  goal: string,
  answers: readonly { id: string; answer: string }[],
  stillOpen: readonly string[],
): unknown {
  const answerFor = (id: string) => answers.find((entry) => entry.id === id)?.answer;

  const scopeIn = [
    `Deliver: ${goal}`,
    answerFor("q_outcome") ?? "A working end-to-end path",
    answerFor("q_scope") ?? "Only the parts of the workspace this needs to reach",
  ];

  return {
    note: "Folded your answers into the spec.",
    patch: {
      goal,
      scope: {
        in: scopeIn,
        out: ["Release, deployment and packaging", "Anything the goal above does not name"],
      },
      constraints: [
        "Stay inside the workspace's existing toolchain and conventions",
        "No new runtime dependency without saying why in the spec",
      ],
      expectedOutcome: `${goal} — merged, verified, and explained well enough that someone else can pick it up.`,
      acceptanceCriteria: [
        {
          id: "ac_tests",
          text: "The project's test command passes, with the new behaviour covered by a test that would fail without it.",
          verification: { kind: "test", command: "pnpm test" },
        },
        {
          id: "ac_build",
          text: "A clean build of the workspace exits 0.",
          verification: { kind: "command", command: "pnpm build", expectExitCode: 0 },
        },
        {
          id: "ac_docs",
          text: "The change is described where a maintainer would look for it, and the description matches the code.",
          verification: {
            kind: "manual_review",
            instructions:
              "Read the new documentation next to the diff and confirm it describes what the code does.",
          },
        },
      ],
      // Anything the user skipped is closed with a stated assumption rather
      // than left blocking the spec (PLAN.md §4.1 stop rule).
      answeredQuestions: stillOpen.map((id) => ({
        id,
        answer: "(assumed) use the workspace's existing conventions",
      })),
    },
  };
}

function planFor(goal: string, criteria: readonly string[]): unknown {
  const [tests, build, docs] = pickCriteria(criteria);
  const config = (reasoning: string, sandbox: string) => ({
    reasoning,
    sandbox,
    timeoutMs: 900_000,
  });

  return {
    summary: `Four tasks to deliver: ${goal}.`,
    tasks: [
      {
        id: "t1_survey",
        title: "Survey the workspace and pin the approach",
        description:
          "Read the code the change touches and write down the approach, the files involved and the risks.",
        dependsOn: [],
        acceptanceCriteriaIds: [build],
        harness: "codex",
        harnessConfig: config("high", "read-only"),
      },
      {
        id: "t2_implement",
        title: "Implement the change",
        description: `Implement: ${goal}. Follow the approach from the survey task and keep the build green.`,
        dependsOn: ["t1_survey"],
        acceptanceCriteriaIds: [build],
        harness: "codex",
        harnessConfig: config("high", "workspace-write"),
      },
      {
        id: "t3_tests",
        title: "Cover the change with tests",
        description:
          "Add a test that fails without the change and passes with it, then run the whole suite.",
        dependsOn: ["t2_implement"],
        acceptanceCriteriaIds: [tests],
        harness: "opencode",
        harnessConfig: config("medium", "workspace-write"),
      },
      {
        id: "t4_docs",
        title: "Document the change",
        description: "Describe the change where a maintainer would look for it.",
        dependsOn: ["t2_implement"],
        acceptanceCriteriaIds: [docs],
        harness: "opencode",
        harnessConfig: config("low", "workspace-write"),
      },
    ],
  };
}

/** Use the spec's real criterion ids, falling back to the ones we wrote. */
function pickCriteria(criteria: readonly string[]): [string, string, string] {
  const known = criteria.length >= 3 ? criteria : DEFAULT_CRITERIA;
  return [known[0] ?? "ac_tests", known[1] ?? "ac_build", known[2] ?? "ac_docs"];
}

/* -------------------------------------------------------- reading the input */

function phaseOf(systemSuffix: string): string {
  return /^phase:\s*(\S+)$/m.exec(systemSuffix)?.[1] ?? "intake";
}

/** Ids listed under `open questions:` in the spec digest. */
function openQuestionIds(systemSuffix: string): string[] {
  return sectionIds(systemSuffix, "open questions:");
}

/** Ids listed under `acceptance criteria:` in the spec digest. */
function criterionIds(systemSuffix: string): string[] {
  return sectionIds(systemSuffix, "acceptance criteria:");
}

function sectionIds(systemSuffix: string, heading: string): string[] {
  const lines = systemSuffix.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+\[([^\]]+)]/.exec(line);
    if (!match) break;
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

/**
 * How many times each tool was called across the whole transcript.
 *
 * `toolsUsed` answers "ever?", which is the right question while the script is
 * marching through the phases once. `summarize` is called in two different
 * phases, so the later ones need a count instead.
 */
function toolUseCounts(messages: readonly LlmMessageParam[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (typeof block === "object" && block !== null && block.type === "tool_use") {
        counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function toolsUsed(messages: readonly LlmMessageParam[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (typeof block === "object" && block !== null && block.type === "tool_use") {
        names.add(block.name);
      }
    }
  }
  return names;
}

function firstUserText(messages: readonly LlmMessageParam[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return oneLine(message.content);
    for (const block of message.content) {
      if (typeof block === "object" && block !== null && block.type === "text") {
        return oneLine(block.text);
      }
    }
  }
  return "the work described in this thread";
}

/**
 * The answers the user gave to `ask_user`.
 *
 * The session answers a suspended call by splicing a `tool_result` carrying
 * `{answers: [...]}` into the history, so they can be read straight back out
 * without the demo tracking anything itself.
 */
function answersGiven(messages: readonly LlmMessageParam[]): { id: string; answer: string }[] {
  const collected: { id: string; answer: string }[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null || block.type !== "tool_result") continue;
      for (const answer of parseAnswers(block.content)) collected.push(answer);
    }
  }
  return collected;
}

function parseAnswers(content: unknown): { id: string; answer: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { id: string; answer: string }[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { type?: string; text?: string }).text;
    if ((part as { type?: string }).type !== "text" || typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as { answers?: unknown };
      if (!Array.isArray(parsed.answers)) continue;
      for (const entry of parsed.answers) {
        const record = entry as { id?: unknown; answer?: unknown };
        if (typeof record.id === "string" && typeof record.answer === "string") {
          out.push({ id: record.id, answer: record.answer });
        }
      }
    } catch {
      // Not JSON — an ordinary tool result. Nothing to read.
    }
  }
  return out;
}

/* ----------------------------------------------------------------- plumbing */

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

/** Split on sentence boundaries so the stream reads like a model writing. */
function chunks(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]?\s*/g);
  return parts && parts.length > 0 ? parts : [text];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(content: LlmContentBlock[], hasToolUse: boolean, index: number): LlmMessage {
  return {
    id: `msg_demo_${index}`,
    type: "message",
    role: "assistant",
    model: DEMO_MODEL,
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    container: null,
    context_management: null,
    diagnostics: null,
  };
}
