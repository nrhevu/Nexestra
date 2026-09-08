import type { Thread } from "../shared/contracts.js";

export function readBrowserValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeBrowserValue(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

interface Draft {
  text: string;
  revision: number;
  saved: boolean;
}

// Owned by one App instance, so view unmounts and denied storage cannot discard drafts.
// Reads never write: a restored draft cannot be removed by an empty hydration effect.
export class ConversationState {
  private readonly drafts = new Map<string, Draft>();
  private readonly lastThreads = new Map<string, string | null>();

  private draftKey(workspaceId: string, threadId: string): string {
    return `nexestra.draft.${workspaceId}:${threadId}`;
  }

  // The pre-workspace key (`nexestra.draft.<threadId>`) is read only when no scoped value
  // exists. Clearing writes an empty scoped tombstone, so a later read cannot resurrect the
  // legacy text after the sent revision was retired.
  draft(workspaceId: string, threadId: string): Draft {
    const key = this.draftKey(workspaceId, threadId);
    let draft = this.drafts.get(key);
    if (!draft) {
      const scoped = readBrowserValue(key);
      const legacyText =
        scoped === null ? (readBrowserValue(`nexestra.draft.${threadId}`) ?? "") : "";
      draft = {
        text: scoped ?? legacyText,
        revision: 0,
        saved: true,
      };
      this.drafts.set(key, draft);
    }
    return draft;
  }

  // Every update advances the revision, including the empty value after a successful send.
  // A send acknowledgement can therefore never clear a newer edit: it only wins when the
  // revision it captured is still current. The empty scoped key also acts as a tombstone that
  // suppresses the legacy fallback on future reads.
  updateDraft(workspaceId: string, threadId: string, text: string): void {
    const key = this.draftKey(workspaceId, threadId);
    const previous = this.draft(workspaceId, threadId);
    this.drafts.set(key, {
      text,
      revision: previous.revision + 1,
      saved: writeBrowserValue(key, text || ""),
    });
  }

  clearSentDraft(workspaceId: string, threadId: string, revision: number): boolean {
    if (this.draft(workspaceId, threadId).revision !== revision) return false;
    this.updateDraft(workspaceId, threadId, "");
    return true;
  }

  resolveThread(workspaceId: string, threads: Thread[], explicitId?: string): string | undefined {
    const validThreads = threads.filter((thread) => thread.workspaceId === workspaceId);
    if (validThreads.some((thread) => thread.id === explicitId)) return explicitId;
    if (!this.lastThreads.has(workspaceId)) {
      this.lastThreads.set(workspaceId, readBrowserValue(`nexestra.lastThread.${workspaceId}`));
    }
    const savedId = this.lastThreads.get(workspaceId);
    return validThreads.find((thread) => thread.id === savedId)?.id ?? validThreads[0]?.id;
  }

  rememberThread(workspaceId: string, threadId: string): void {
    if (this.lastThreads.get(workspaceId) === threadId) return;
    this.lastThreads.set(workspaceId, threadId);
    writeBrowserValue(`nexestra.lastThread.${workspaceId}`, threadId);
  }
}
