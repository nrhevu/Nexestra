/**
 * `@nexestra/storage` — SQLite event store and projections (PLAN.md §1.4/§3).
 *
 * Every write goes through a command on `NexestraStore`, which writes the
 * projection row and appends the matching event in one transaction. Projection
 * tables can therefore always be rebuilt from `events` (see `replay.ts`).
 */
export {
  applyMigrations,
  type NexestraDatabase,
  type OpenDatabaseOptions,
  openDatabase,
  schema,
} from "./db.js";
export {
  type AppendEventInput,
  type EventListener,
  EventStore,
} from "./event-store.js";
export { newId, now } from "./ids.js";
export { MIGRATIONS, type Migration } from "./migrations.js";
export { databasePath, dataDirectory, nexestraHome } from "./paths.js";
export { rebuildProjections } from "./replay.js";
export * as tables from "./schema.js";
export { seedMock } from "./seed.js";
export { type CreateStoreOptions, createStore, NexestraStore, NotFoundError } from "./store.js";
