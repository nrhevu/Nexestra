/**
 * `@nexestra/adapter-opencode` — drives `opencode serve` over HTTP + SSE
 * (PLAN.md §5).
 *
 * The protocol this implements was recorded from OpenCode 1.18.25 and is
 * documented in `docs/harness-protocols.md` §2; the adapter's own mapping,
 * permission model and limitations are in `docs/adapters/opencode.md`.
 */
export const OPENCODE_ID = "opencode" as const;

export type {
  OpenCodeAdapter,
  OpenCodeFinalStructured,
  OpenCodeRunHandle,
} from "./adapter.js";
export { createOpenCodeAdapter, splitModelRef } from "./adapter.js";
export type { OpenCodeClientOptions, OpenCodeSessionStatusEntry } from "./client.js";
export { OpenCodeClient } from "./client.js";
export type { DiscoverOpenCodeContext } from "./discover.js";
export {
  defaultModelFrom,
  discoverOpenCode,
  findOpenCodeBinary,
  isSupportedOpenCodeVersion,
  modelsFromProviders,
  parseOpenCodeVersion,
} from "./discover.js";
export type { OpenCodeControlAction, OpenCodeControlResult } from "./errors.js";
export {
  OpenCodeDiscoveryError,
  OpenCodeHttpError,
  OpenCodePrepareError,
  OpenCodeRunError,
  OpenCodeServerError,
  OpenCodeUnsupportedControlError,
} from "./errors.js";
export type {
  OpenCodeEventListener,
  OpenCodeEventStreamOptions,
  OpenCodeLifecycleListener,
  OpenCodeStreamLifecycle,
} from "./events.js";
export { eventSessionId, OpenCodeEventStream } from "./events.js";
export type {
  OpenCodeMapperOptions,
  OpenCodeMapperState,
  OpenCodePatchRecord,
  OpenCodePendingPermission,
  OpenCodeTerminal,
} from "./mapper.js";
export { OpenCodeMapper } from "./mapper.js";
export type {
  OpenCodeAdapterOptions,
  OpenCodeLogger,
  OpenCodeToolId,
  OpenCodeUsageTotals,
  ResolvedOpenCodeOptions,
} from "./options.js";
export {
  DEFAULT_OPENCODE_AGENT,
  DEFAULT_OPENCODE_REVIEW_AGENT,
  MAX_OPENCODE_VERSION_EXCLUSIVE,
  MIN_OPENCODE_VERSION,
  OPENCODE_NETWORK_TOOL_IDS,
  OPENCODE_SANDBOX_MODES,
  OPENCODE_TOOL_IDS,
  OPENCODE_WRITE_TOOL_IDS,
  REASONING_TO_OPENCODE_VARIANT,
  resolveOptions,
  SUPPORTED_OPENCODE_RANGE,
  TESTED_OPENCODE_VERSION,
} from "./options.js";
export {
  OPENCODE_PERMISSION_KEYS,
  permissionDescription,
  permissionRisk,
  permissionRulesetFor,
  toolMapFor,
} from "./permission.js";
export { AsyncQueue } from "./queue.js";
export type { OpenCodeReview, OpenCodeReviewFinding, ParsedReview } from "./review.js";
export {
  buildReviewPrompt,
  describeReviewTarget,
  OPENCODE_REVIEW_FINDINGS_SCHEMA,
  OpenCodeReviewFindingSchema,
  OpenCodeReviewSchema,
  parseReviewFindings,
  REVIEW_SEVERITIES,
} from "./review.js";
export type { OpenCodeServerHandle, OpenCodeServerManagerOptions } from "./server.js";
export { OpenCodeServerManager, parseServerUrl } from "./server.js";
export type { SseFrame } from "./sse.js";
export { parseSseJson, SseDecoder } from "./sse.js";
export type {
  OpenCodeAgent,
  OpenCodeError,
  OpenCodeEvent,
  OpenCodeFileChangeKind,
  OpenCodeHealth,
  OpenCodeMessage,
  OpenCodeMessageInfo,
  OpenCodePart,
  OpenCodePermissionAction,
  OpenCodePermissionReply,
  OpenCodePermissionRequest,
  OpenCodePermissionRule,
  OpenCodePermissionRuleset,
  OpenCodePromptBody,
  OpenCodeProvider,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeSessionCreateBody,
  OpenCodeSessionStatus,
  OpenCodeTokens,
  OpenCodeToolState,
} from "./types.js";
export {
  ABORTED_ERROR_NAME,
  HANDLED_OPENCODE_EVENT_TYPES,
  isHandledOpenCodeEventType,
  mapFileChangeKind,
} from "./types.js";
