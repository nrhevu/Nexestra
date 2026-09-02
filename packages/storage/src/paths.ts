import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all Nexestra state on the local machine (`NEXESTRA_HOME` wins). */
export function nexestraHome(): string {
  return process.env.NEXESTRA_HOME ?? join(homedir(), ".nexestra");
}

/** The SQLite database file. */
export function databasePath(home: string = nexestraHome()): string {
  return join(home, "nexestra.db");
}

/** Where artifact bytes (diffs, logs, test reports) are written. */
export function dataDirectory(home: string = nexestraHome()): string {
  return join(home, "data");
}
