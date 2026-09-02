/**
 * The scripted fake harness now lives in `@nexestra/adapter-fake`, so the
 * adapter contract and orchestrator integration tests drive the same
 * implementation (M7/M8).
 *
 * This local test-support module re-exports the pieces the loop's own tests
 * use. External test code should import `@nexestra/adapter-fake` directly.
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
