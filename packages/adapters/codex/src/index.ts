/**
 * `@nexestra/adapter-codex` — drives `codex exec --json` (PLAN.md §5).
 *
 * The protocol this implements was recorded from Codex CLI 0.148.0 and is
 * documented in `docs/harness-protocols.md` §1; the adapter's own mapping and
 * limitations are in `docs/adapters/codex.md`.
 */
export const CODEX_ID = "codex" as const;

export type { CodexAdapter, CodexFinalStructured, CodexRunHandle } from "./adapter.js";
export { createCodexAdapter } from "./adapter.js";
export type { CodexCommandContext, CodexCommandLine } from "./command.js";
export { buildCodexCommand } from "./command.js";
export {
  discoverCodex,
  findCodexBinary,
  isSupportedCodexVersion,
  parseCodexVersion,
} from "./discover.js";
export type { CodexControlAction, CodexControlResult } from "./errors.js";
export {
  CodexDiscoveryError,
  CodexPrepareError,
  CodexRunError,
  CodexUnsupportedControlError,
} from "./errors.js";
export { JsonlSplitter } from "./jsonl.js";
export type { CodexAdapterOptions, CodexLogger, CodexReasoningEffort } from "./options.js";
export {
  CODEX_REASONING_EFFORTS,
  CODEX_SANDBOX_MODES,
  KNOWN_CODEX_MODELS,
  MAX_CODEX_VERSION_EXCLUSIVE,
  MIN_CODEX_VERSION,
  REASONING_TO_CODEX_EFFORT,
  SUPPORTED_CODEX_RANGE,
  TESTED_CODEX_VERSION,
} from "./options.js";
export type { CodexParserOptions, CodexParserState } from "./parser.js";
export { CodexStreamParser, classifyCodexError } from "./parser.js";
export type { CodexProcess, SpawnCodexOptions } from "./process.js";
export { killProcessGroup, spawnCodex } from "./process.js";
export type { CodexReviewFinding, ParsedReview, ReviewSeverity } from "./review.js";
export {
  CODEX_REVIEW_FINDINGS_SCHEMA,
  parseReviewFindings,
  REVIEW_SEVERITIES,
} from "./review.js";
export type {
  CodexEventType,
  CodexFileChange,
  CodexItemType,
  CodexThreadEvent,
  CodexThreadItem,
  CodexTodoItem,
  CodexUsage,
} from "./types.js";
export {
  KNOWN_CODEX_EVENT_TYPES,
  KNOWN_CODEX_ITEM_TYPES,
  mapFileChangeKind,
} from "./types.js";
export type {
  DiffOptions,
  EnsureWorktreeResult,
  FileChangeKind,
  WorktreeChangedFile,
  WorktreeDiff,
} from "./worktree.js";
export {
  changedFiles,
  diff,
  EMPTY_TREE_HASH,
  ensureWorktree,
  GitError,
  hasCommits,
  isGitRepo,
  removeWorktree,
  repoRoot,
} from "./worktree.js";
