/**
 * `@nexestra/master` — the Master agent (PLAN.md §4).
 *
 * The Master turns a vague request into a frozen Spec and a validated Plan,
 * then supervises the harnesses that do the work. It is a library: no HTTP, no
 * database, no process spawning. Side effects go through `MasterHost`,
 * conversation state goes through `MasterStore`, and the model goes through
 * `LlmClient` — so the whole loop runs in tests against `FakeHost` and
 * `FakeLlmClient` without an API key.
 *
 * ```ts
 * const session = createMasterSession({ threadId, host, llm, store });
 * for await (const event of session.send("build me a todo CLI")) { … }
 * ```
 *
 * See `docs/master.md` for the event catalogue and the host contract.
 */

/* Events and inputs */
export type {
  ApprovalDecisionInput,
  ContinueInput,
  MasterError,
  MasterErrorCode,
  MasterEvent,
  MasterInput,
  MasterTurnOutcome,
  MasterUsageTotals,
  ToolAnswerInput,
  UserMessageInput,
} from "./events.js";
export {
  createFakeHost,
  type FakeHost,
  type FakeHostCall,
  type FakeHostOptions,
} from "./fake-host.js";
/* Host contract */
export type {
  ApprovalRequestResult,
  DispatchTaskResult,
  MarkCriterionResult,
  MasterHost,
  ReadArtifactResult,
  ReadRunEventsResult,
  ReadWorkspaceResult,
  RunEventSummary,
  RunVerificationResult,
  SearchCodeMatch,
  SearchCodeResult,
  TaskDispatchDefaults,
  VerificationOutcome,
  WorkspaceEntry,
  WorkspaceManifest,
} from "./host.js";
/* Model access */
export {
  type AnthropicLlmClientOptions,
  createAnthropicLlmClient,
  hasAnthropicCredentials,
  MASTER_BETAS,
  MASTER_MODEL,
} from "./llm/anthropic.js";
export { createFakeLlmClient, type FakeLlmClient, type FakeTurn } from "./llm/fake.js";
export type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmMessageParam,
  LlmRequest,
  LlmStreamEvent,
  LlmTool,
  LlmToolResultBlock,
  LlmToolUseBlock,
  LlmUsage,
} from "./llm/types.js";
/* Phase machine */
export {
  EMPTY_PHASE_CONTEXT,
  isToolAllowedInPhase,
  MASTER_TOOL_NAMES,
  MASTER_TOOLS_BY_PHASE,
  type MasterToolName,
  nextPhase,
  type PhaseContext,
  type PhaseTransition,
  type PhaseTrigger,
} from "./phase.js";
export {
  applyReplan,
  buildPlanProposal,
  type MasterPlanProposal,
  type MasterPlanTask,
  type PlanValidation,
  type PlanValidationIssue,
  validatePlanTasks,
} from "./plan.js";
/* Prompts and accounting */
export { loadPromptSet, type MasterPromptSet, systemPromptFor } from "./prompts/index.js";
/* Session */
export {
  createMasterSession,
  type MasterSession,
  type MasterSessionConfig,
} from "./session.js";
/* Spec and plan helpers */
export {
  addAskedQuestions,
  answerQuestions,
  applySpecPatch,
  createEmptySpec,
  renderSpec,
  type SpecIdentity,
  unansweredQuestions,
  unverifiedCriteria,
} from "./spec.js";
/* Store */
export {
  createInMemoryMasterStore,
  type MasterStore,
  type MasterThreadState,
  type PendingToolCall,
} from "./store.js";
/* Tools */
export {
  getToolDefinition,
  MASTER_TOOL_DEFINITIONS,
  type MasterToolDefinition,
  type ToolListOptions,
  toolJsonSchema,
  toolsForPhase,
  WEB_SEARCH_TOOL,
} from "./tools/definitions.js";
export { type JsonSchemaObject, toStrictJsonSchema } from "./tools/json-schema.js";
export type {
  AskUserInput,
  AskUserQuestion,
  ControlRunInput,
  DispatchTaskInput,
  MarkCriterionInput,
  PlanTaskHarnessConfig,
  PlanTaskInput,
  ProposePlanInput,
  ReadArtifactInput,
  ReadRunEventsInput,
  ReadWorkspaceInput,
  RecordMemoryInput,
  ReplanInput,
  RequestApprovalInput,
  RunVerificationInput,
  SearchCodeInput,
  SpecPatch,
  SummarizeInput,
  UpdateSpecInput,
} from "./tools/schemas.js";
export {
  AskUserInputSchema,
  AskUserQuestionSchema,
  ControlRunInputSchema,
  DispatchTaskInputSchema,
  MarkCriterionInputSchema,
  ProposePlanInputSchema,
  ReadArtifactInputSchema,
  ReadRunEventsInputSchema,
  ReadWorkspaceInputSchema,
  RecordMemoryInputSchema,
  ReplanInputSchema,
  RequestApprovalInputSchema,
  RunVerificationInputSchema,
  SearchCodeInputSchema,
  SpecPatchSchema,
  SummarizeInputSchema,
  UpdateSpecInputSchema,
} from "./tools/schemas.js";
export {
  createFsWorkspaceReader,
  DEFAULT_IGNORED_DIRECTORIES,
  type FsWorkspaceReader,
  type FsWorkspaceReaderOptions,
} from "./tools/workspace.js";
export {
  addUsage,
  BUDGET_WARNING_RATIO,
  type BudgetState,
  budgetState,
  estimateCostUSD,
  toUsageTotals,
  ZERO_USAGE,
} from "./usage.js";
