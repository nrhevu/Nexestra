/**
 * The scripted fake harness now lives in `@nexestra/adapter-fake`, so the
 * adapter contract tests, the orchestrator tests and the Playwright suite all
 * drive the same implementation (M7).
 *
 * This file is kept as the orchestrator's import path for it, and re-exports
 * the pieces the loop's own tests use. New code should import
 * `@nexestra/adapter-fake` — and prefer `createFakeAdapter()`, which is driven
 * by named scenarios rather than by hand-written event lists.
 */
export type {
  FakeAdapterCall,
  FakeAdapterOptions,
  FakeHarnessAdapter,
  FakeRunContext,
  FakeRunScript,
  FakeStreamContext,
} from "@nexestra/adapter-fake";
export {
  createFakeAdapter,
  createFakeHarnessAdapter,
  fatalFailure,
  retryableFailure,
  reviewFindings,
  writesFiles,
} from "@nexestra/adapter-fake";
