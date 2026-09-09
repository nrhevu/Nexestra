import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { ConversationFilter } from "./unreadNavigation.js";
import "./ConversationFilterControls.css";

export interface ConversationFilterControlsProps {
  filter: ConversationFilter;
  onFilterChange: (filter: ConversationFilter) => void;
  unreadConversationCount: number;
  onNextUnread: () => void;
}

export function ConversationFilterControls({
  filter,
  onFilterChange,
  unreadConversationCount,
  onNextUnread,
}: ConversationFilterControlsProps) {
  const countId = useId();
  return (
    <fieldset className="conversation-filter" aria-label="Conversation filter">
      <button
        type="button"
        className={
          filter === "all"
            ? "conversation-filter-option conversation-filter-option-active"
            : "conversation-filter-option"
        }
        aria-pressed={filter === "all"}
        aria-label="All conversations"
        onClick={() => onFilterChange("all")}
      >
        All
      </button>
      <button
        type="button"
        className={
          filter === "unread"
            ? "conversation-filter-option conversation-filter-option-active"
            : "conversation-filter-option"
        }
        aria-pressed={filter === "unread"}
        aria-label="Unread conversations"
        aria-describedby={countId}
        onClick={() => onFilterChange("unread")}
      >
        <span>Unread</span>
        <span id={countId} className="conversation-filter-count">
          {unreadConversationCount}
        </span>
      </button>
      <button
        type="button"
        className="conversation-filter-next"
        aria-label="Next unread conversation"
        title="Next unread conversation (/next unread)"
        disabled={unreadConversationCount === 0}
        onClick={onNextUnread}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
    </fieldset>
  );
}
