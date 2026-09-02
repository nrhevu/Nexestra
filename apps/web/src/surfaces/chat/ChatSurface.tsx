import type { Message, MessageAttachment } from "@nexestra/core";
import { Button, Composer, KeyHint, Tag } from "@nexestra/ui-kit";
import { useEffect, useRef, useState } from "react";
import { useMessages, useSendMessage, useThreads } from "../../lib/api.js";
import { formatTime, formatUsd, phaseTone } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { ChatSidebar } from "./ChatSidebar.js";

export interface ChatSurfaceProps {
  workspaceId: string;
  threadId: string;
}

export function ChatSurface({ workspaceId, threadId }: ChatSurfaceProps) {
  const threads = useThreads(workspaceId);
  const messages = useMessages(threadId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);

  const sendMessage = useSendMessage(threadId);
  const composerFocusNonce = useUiStore((state) => state.composerFocusNonce);

  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (composerFocusNonce > 0) composerRef.current?.focus();
  }, [composerFocusNonce]);

  const timeline = messages.data ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the timeline grows
  useEffect(() => {
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [timeline.length]);

  /** Stores a user message. Master does not reply yet — that lands in M2. */
  const send = () => {
    const content = draft.trim();
    if (!content || sendMessage.isPending) return;
    setDraft("");
    sendMessage.mutate({ role: "user", content }, { onError: () => setDraft(content) });
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
            {timeline.map((message) => (
              <MessageBlock key={message.id} message={message} />
            ))}
          </div>

          <Composer
            textareaRef={composerRef}
            value={draft}
            placeholder="Message Master..."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            action={
              <Button tone="primary" boxed onClick={send} title="Send (Enter)">
                {">"}
              </Button>
            }
            hints={
              <>
                <span className="nx-composer__token">@agent</span>
                <span className="nx-composer__token">#ref</span>
                <span className="nx-composer__token">/command</span>
                <span>Enter to send · Shift+Enter for a new line</span>
              </>
            }
          />
        </div>
      }
      sidebarTitle="Context"
      sidebar={<ChatSidebar workspaceId={workspaceId} threadId={threadId} />}
    />
  );
}

function MessageBlock({ message }: { message: Message }) {
  const { attachments, references, toolCalls } = message;

  return (
    <article className="msg">
      <div className="msg__head">
        <span className={`msg__role msg__role--${message.role}`}>{message.role}</span>
        <span className="msg__time">{formatTime(message.createdAt)}</span>
      </div>
      <div className="msg__body">{message.content}</div>

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
        <div className="card" key={call.callId}>
          <div className="card__head">
            <span>tool call</span>
            <span className="card__title">{call.name}</span>
            <span style={{ marginLeft: "auto" }}>
              <Tag tone={call.ok ? "accent" : "danger"}>{call.ok ? "ok" : "failed"}</Tag>
            </span>
          </div>
          <div className="card__body">
            <pre className="card__pre">{JSON.stringify(call.input, null, 2)}</pre>
          </div>
        </div>
      ))}

      {attachments.map((attachment) => (
        <AttachmentCard
          key={`${message.id}-${attachment.kind}-${attachment.title}`}
          attachment={attachment}
        />
      ))}
    </article>
  );
}

function AttachmentCard({ attachment }: { attachment: MessageAttachment }) {
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
    case "plan_preview":
      return (
        <ol className="card__list">
          {attachment.taskTitles.map((title) => (
            <li key={title}>{title}</li>
          ))}
        </ol>
      );
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
