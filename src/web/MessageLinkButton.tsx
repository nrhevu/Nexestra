import { Check, Link as LinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import "./MessageLinkButton.css";

type Phase = "idle" | "pending" | "copied" | "manual";

function messageLinkUrl(threadId: string, messageId: string): string {
  return new URL(
    `/threads/${encodeURIComponent(threadId)}?message=${encodeURIComponent(messageId)}`,
    window.location.href,
  ).toString();
}

export function MessageLinkButton({
  threadId,
  messageId,
}: {
  threadId: string;
  messageId: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [manualUrl, setManualUrl] = useState<string>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase !== "manual") return;
    const input = manualInputRef.current;
    if (!input) return;
    const active = document.activeElement;
    if (active === input) {
      input.select();
      return;
    }
    if (active === buttonRef.current) {
      input.focus();
      input.select();
    }
  }, [phase]);

  const handleCopy = useCallback(async () => {
    if (phase === "pending") return;
    setPhase("pending");
    const url = messageLinkUrl(threadId, messageId);
    if (!navigator.clipboard?.writeText) {
      setManualUrl(url);
      setPhase("manual");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setPhase("copied");
    } catch {
      setManualUrl(url);
      setPhase("manual");
    }
  }, [messageId, phase, threadId]);

  const copied = phase === "copied";
  return (
    <span className={phase === "manual" ? "message-link manual" : "message-link"}>
      <button
        ref={buttonRef}
        type="button"
        className={copied ? "copied" : undefined}
        aria-label="Copy message link"
        title="Copy message link"
        aria-disabled={phase === "pending"}
        onClick={handleCopy}
      >
        {copied ? <Check size={14} /> : <LinkIcon size={14} />}
      </button>
      {copied && (
        <span className="message-link-status" role="status">
          Copied
        </span>
      )}
      {phase === "manual" && manualUrl && (
        <span className="message-link-manual" role="status">
          <span>Copy manually:</span>
          <input
            ref={manualInputRef}
            readOnly
            value={manualUrl}
            aria-label="Message link"
            onFocus={(event) => event.currentTarget.select()}
          />
        </span>
      )}
    </span>
  );
}
