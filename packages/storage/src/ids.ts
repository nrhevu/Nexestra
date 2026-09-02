import { randomUUID } from "node:crypto";

/**
 * Human-readable opaque ids (`task_1a2b3c4d`), matching the shape used by the
 * mock fixtures so nothing in the UI has to care where a row came from.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** ISO-8601 timestamp with milliseconds, the format every domain schema wants. */
export function now(): string {
  return new Date().toISOString();
}
