/**
 * `@nexestra/storage` — SQLite event store and projections (PLAN.md §1.4/§3).
 *
 * Filled in at M1: Drizzle schema, append-only `events` table, projection
 * rebuild and the entity tables the REST API reads from.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all Nexestra state on the local machine. */
export function nexestraHome(): string {
  return process.env.NEXESTRA_HOME ?? join(homedir(), ".nexestra");
}

export function databasePath(): string {
  return join(nexestraHome(), "nexestra.db");
}

export function dataDirectory(): string {
  return join(nexestraHome(), "data");
}

/** Placeholder until the event store lands in M1. */
export function openStore(): never {
  throw new Error("@nexestra/storage is not implemented until milestone M1");
}
