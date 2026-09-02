import type { Message, MessageAttachment, OrchestratorProgress, Task } from "@nexestra/core";
import { Button, Composer, KeyHint, StatusDot, Tag } from "@nexestra/ui-kit";
import { useEffect, useRef, useState } from "react";
import {
  useApprovals,
  useMasterCancel,
  useMasterSend,
  useMasterState,
  useMessages,
  useResolveApproval,
  useSpec,
  useTasks,
  useThreadProgress,
  useThreads,
} from "../../lib/api.js";
import { formatTime, formatUsd, phaseTone } from "../../lib/format.js";
import { useMasterStream } from "../../lib/master.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { ApprovalBanner } from "./ApprovalBanner.js";
import { ChatSidebar } from "./ChatSidebar.js";
import { PlanCard } from "./PlanCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { SpecCard } from "./SpecCard.js";
import { ToolCallCard } from "./ToolCallCard.js";

export interface ChatSurfaceProps {
  workspaceId: string;
  threadId: string;
}

/**
 * Surface 1 — the conversation with the Master.
 *
 * Three things are on screen at once and they come from different places:
 * the persisted transcript (`messages`), the turn currently streaming
 * (`useMasterStream`, fed by `master.*` events over `/ws`), and whatever the
 * Master is blocked on (a question card, an approval banner). The composer is
 * disabled whenever a turn is in flight, because the server refuses a second
 * user message on a busy thread rather than interleaving two model loops.
 */
export function ChatSurface({ workspaceId, threadId }: ChatSurfaceProps) {
  const threads = useThreads(workspaceId);
  const messages = useMessages(threadId);
  const spec = useSpec(threadId);
  const tasks = useTasks(threadId);
  const approvals = useApprovals(workspaceId);
  const masterState = useMasterState(threadId);
  const progress = useThreadProgress(threadId);
  const stream = useMasterStream(threadId);

  const send = useMasterSend(threadId);
  const cancel = useMasterCancel(threadId);
  const resolveApproval = useResolveApproval(workspaceId);

  const thread = (threads.data ?? []).find((item) => item.id === threadId);
  const composerFocusNonce = useUiStore((state) => state.composerFocusNonce);

  const [draft, setDraft] = useState("");
  const [answeredCallId, setAnsweredCallId] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (composerFocusNonce > 0) composerRef.current?.focus();
  }, [composerFocusNonce]);

  // The Master's transcript and the orchestrator's progress are two logs of the
  // same thread; interleaving them by time is the only way a reader can tell
  // that a run started *because* of what the Master had just said.
  const timeline = mergeTimeline(messages.data ?? [], progress.data ?? []);
  const busy = stream.busy || masterState.data?.busy === true;

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail as the turn streams
  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [timeline.length, stream.text, stream.toolCalls.length]);

  // The live card wins over the persisted one: a question is answered in the
  // browser before the server has finished the next turn.
  const pendingState = masterState.data?.pending;
  const question =
    stream.question ??
    (pendingState?.kind === "ask_user"
      ? { callId: pendingState.callId, questions: pendingState.questions }
      : null);
  const openQuestion = question && question.callId !== answeredCallId ? question : null;

  // The live block is the turn *before* it becomes a `Message`. It stays up
  // until the persisted reply lands — hiding it the instant `master.done`
  // arrives would blank the screen for as long as the refetch takes, and
  // hiding it never would double every reply.
  const replyPersisted = (messages.data ?? []).at(-1)?.role === "master";
  const showLiveTurn =
    busy || ((stream.text.length > 0 || stream.toolCalls.length > 0) && !replyPersisted);

  const pendingApproval = (approvals.data ?? []).find(
    (approval) => approval.status === "pending" && approval.threadId === threadId,
  );
  const specApprovalPending = pendingApproval?.kind === "spec";

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    send.mutate({ kind: "user_message", text }, { onError: () => setDraft(text) });
  };

  const answer = (answers: { id: string; answer: string }[]) => {
    if (!openQuestion) return;
    setAnsweredCallId(openQuestion.callId);
    send.mutate(
      { kind: "answers", callId: openQuestion.callId, answers },
      { onError: () => setAnsweredCallId(null) },
    );
  };

  return (
    <SurfaceLayout
      id="chat"
      title={`Chat — ${thread?.title ?? threadId}`}
      headerRight={
        thread ? (
          <>
            <Tag tone={phaseTone(thread.phase)}>{thread.phase}</Tag>
            <span className="nx-muted">
              {formatUsd(thread.costUSD)} / {formatUsd(thread.budgetUSD)}
            </span>
            <KeyHint keys={["⌘", "/"]} label="composer" />
          </>
        ) : null
      }
      main={
        <div className="chat">
          <div className="chat__timeline" ref={timelineRef}>
            {messages.isPending ? <div className="state">loading messages…</div> : null}
            {messages.isError ? (
              <div className="state">could not reach /api — is the Nexestra server running?</div>
            ) : null}
            {timeline.length === 0 && !messages.isPending && !busy ? (
              <div className="state">
                Describe what you want, however vaguely. Master will ask what it needs.
              </div>
            ) : null}

            {timeline.map((entry) =>
              entry.kind === "message" ? (
                <MessageBlock
                  key={entry.message.id}
                  message={entry.message}
                  tasks={tasks.data ?? []}
                />
              ) : (
                <ProgressRow key={entry.key} progress={entry.progress} />
              ),
            )}

            {showLiveTurn ? (
              <LiveTurn text={stream.text} toolCalls={stream.toolCalls} busy={busy} />
            ) : null}

            {stream.error ? (
              <div className="card card--error">
                <div className="card__head">
                  <StatusDot tone="error" />
                  <span>master error</span>
                  <span className="card__title">{stream.error.code}</span>
                </div>
                <div className="card__body">{stream.error.message}</div>
              </div>
            ) : null}

            {openQuestion ? (
              <QuestionCard
                callId={openQuestion.callId}
                questions={openQuestion.questions}
                busy={send.isPending || busy}
                onSubmit={answer}
              />
            ) : null}

            {specApprovalPending && spec.data ? <SpecCard spec={spec.data} /> : null}
          </div>

          {pendingApproval ? (
            <ApprovalBanner
              approval={pendingApproval}
              busy={resolveApproval.isPending}
              onResolve={(status) =>
                resolveApproval.mutate({ approvalId: pendingApproval.id, status })
              }
            />
          ) : null}

          <Composer
            textareaRef={composerRef}
            value={draft}
            disabled={busy}
            placeholder={busy ? "Master is working…" : "Message Master..."}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.shiftKey) return;
              // ⌘/Ctrl+Enter and a bare Enter both send; Shift+Enter is a newline.
              event.preventDefault();
              submit();
            }}
            action={
              busy ? (
                <Button
                  tone="danger"
                  boxed
                  onClick={() => cancel.mutate()}
                  title="Stop the current turn"
                >
                  ■
                </Button>
              ) : (
                <Button tone="primary" boxed onClick={submit} title="Send (⌘Enter)">
                  {">"}
                </Button>
              )
            }
            hints={
              busy ? (
                <>
                  <StatusDot tone="running" />
                  <span>Master is thinking — the composer unlocks when the turn ends</span>
                  {stream.costUSD !== null ? (
                    <span className="nx-muted">{formatUsd(stream.costUSD)}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="nx-composer__token">@agent</span>
                  <span className="nx-composer__token">#ref</span>
                  <span className="nx-composer__token">/command</span>
                  <span>⌘Enter to send · Shift+Enter for a new line</span>
                  {send.isError ? <span className="form-error">{send.error.message}</span> : null}
                </>
              )
            }
          />
        </div>
      }
      sidebarTitle="Context"
      sidebar={<ChatSidebar workspaceId={workspaceId} threadId={threadId} />}
    />
  );
}

type TimelineEntry =
  | { kind: "message"; at: string; message: Message }
  | { kind: "progress"; at: string; key: string; progress: OrchestratorProgress };

function mergeTimeline(
  messages: readonly Message[],
  progress: readonly OrchestratorProgress[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...messages.map(
      (message): TimelineEntry => ({ kind: "message", at: message.createdAt, message }),
    ),
    ...progress.map(
      (item, index): TimelineEntry => ({
        kind: "progress",
        at: item.at,
        key: `${item.at}:${item.kind}:${index}`,
        progress: item,
      }),
    ),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * One orchestrator event, as a compact system row.
 *
 * Deliberately not a message bubble: these are hundreds of lines over a long
 * run, and they are the loop narrating itself, not somebody talking.
 */
function ProgressRow({ progress }: { progress: OrchestratorProgress }) {
  return (
    <div className={`sysrow sysrow--${progress.level}`} title={progress.kind}>
      <span className="sysrow__time">{formatTime(progress.at)}</span>
      <span className="sysrow__glyph">
        {progress.level === "error" ? "✗" : progress.level === "warn" ? "!" : "·"}
      </span>
      <span className="sysrow__text">{progress.message}</span>
    </div>
  );
}

/** The half-written assistant message of a turn still in flight. */
function LiveTurn({
  text,
  toolCalls,
  busy,
}: {
  text: string;
  toolCalls: ReturnType<typeof useMasterStream>["toolCalls"];
  busy: boolean;
}) {
  return (
    <article className="msg msg--live">
      <div className="msg__head">
        <span className="msg__role msg__role--master">master</span>
        {busy ? <StatusDot tone="running" label="streaming" /> : null}
      </div>
      {text ? (
        <div className="msg__body">
          {text}
          {busy ? <span className="msg__caret">▌</span> : null}
        </div>
      ) : (
        <div className="msg__body nx-muted">thinking…</div>
      )}
      {toolCalls.map((call) => (
        <ToolCallCard
          key={call.callId}
          name={call.name}
          input={call.input}
          ok={call.ok}
          output={call.output}
        />
      ))}
    </article>
  );
}

function MessageBlock({ message, tasks }: { message: Message; tasks: readonly Task[] }) {
  const { attachments, references, toolCalls } = message;

  return (
    <article className="msg">
      <div className="msg__head">
        <span className={`msg__role msg__role--${message.role}`}>{message.role}</span>
        <span className="msg__time">{formatTime(message.createdAt)}</span>
      </div>
      {message.content ? <div className="msg__body">{message.content}</div> : null}

      {references.length > 0 ? (
        <div className="msg__refs">
          {references.map((reference) => (
            <Tag key={`${reference.kind}:${reference.id}`} tone="info">
              {reference.label}
            </Tag>
          ))}
        </div>
      ) : null}

      {toolCalls.map((call) => (
        <ToolCallCard
          key={call.callId}
          name={call.name}
          input={call.input}
          ok={call.ok}
          output={call.output}
        />
      ))}

      {attachments.map((attachment) => (
        <AttachmentCard
          key={`${message.id}-${attachment.kind}-${attachment.title}`}
          attachment={attachment}
          tasks={tasks}
        />
      ))}
    </article>
  );
}

function AttachmentCard({
  attachment,
  tasks,
}: {
  attachment: MessageAttachment;
  tasks: readonly Task[];
}) {
  if (attachment.kind === "plan_preview") {
    return (
      <PlanCard
        title={attachment.title}
        tasks={tasks.filter((task) => task.planId === attachment.planId)}
        taskTitles={attachment.taskTitles}
      />
    );
  }

  return (
    <div className="card">
      <div className="card__head">
        <span>Agent response / artifact</span>
        <span className="card__title">{attachment.title}</span>
        <span style={{ marginLeft: "auto" }}>
          <Tag>{attachment.kind}</Tag>
        </span>
      </div>
      <div className="card__body">{renderAttachment(attachment)}</div>
    </div>
  );
}

function renderAttachment(attachment: MessageAttachment) {
  switch (attachment.kind) {
    case "diff":
      return (
        <pre className="card__pre">
          {withStableKeys(attachment.patch.split("\n")).map(({ key, line }) => (
            <div key={key} className={line.startsWith("+") ? "add" : "meta"}>
              {line}
            </div>
          ))}
        </pre>
      );
    case "test_report":
      return (
        <>
          <div style={{ marginBottom: 6 }}>
            <Tag tone="accent">{attachment.passed} passed</Tag>{" "}
            <Tag tone={attachment.failed > 0 ? "danger" : "default"}>
              {attachment.failed} failed
            </Tag>
          </div>
          <pre className="card__pre">{attachment.output}</pre>
        </>
      );
    case "artifact":
      return <pre className="card__pre">{attachment.preview}</pre>;
    default:
      return null;
  }
}

/** Give repeated lines stable, content-derived keys (no array indices). */
function withStableKeys(lines: readonly string[]): Array<{ key: string; line: string }> {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = (seen.get(line) ?? 0) + 1;
    seen.set(line, occurrence);
    return { key: `${line}#${occurrence}`, line };
  });
}
