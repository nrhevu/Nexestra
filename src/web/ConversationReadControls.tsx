import "./ConversationReadControls.css";

export interface ConversationReadControlsProps {
  unreadCount: number;
  onFirstUnread: () => void;
  onMarkRead: () => void;
}

export function ConversationReadControls({
  unreadCount,
  onFirstUnread,
  onMarkRead,
}: ConversationReadControlsProps) {
  const enabled = Number.isInteger(unreadCount) && unreadCount > 0;
  const countText = enabled
    ? `${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`
    : "No unread messages";
  return (
    <div
      className="conversation-read-controls"
      role="toolbar"
      aria-label="Current conversation read controls"
    >
      <span className="conversation-read-count">{countText}</span>
      <button
        type="button"
        aria-label="First unread message"
        disabled={!enabled}
        onClick={onFirstUnread}
      >
        First unread
      </button>
      <button
        type="button"
        aria-label="Mark conversation read"
        disabled={!enabled}
        onClick={onMarkRead}
      >
        Mark read
      </button>
    </div>
  );
}
