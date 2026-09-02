import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";

const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

/** Same split as `scripts/embed-migrations.mjs`, kept independent on purpose. */
async function readMigrationsFromDisk(): Promise<Array<{ tag: string; statements: string[] }>> {
  const files = (await readdir(drizzleDir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (file) => ({
      tag: file.replace(/\.sql$/, ""),
      statements: (await readFile(join(drizzleDir, file), "utf8"))
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean),
    })),
  );
}

describe("embedded migrations", () => {
  it("match the drizzle-kit output on disk", async () => {
    const onDisk = await readMigrationsFromDisk();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(MIGRATIONS.map((migration) => migration.tag)).toEqual(
      onDisk.map((migration) => migration.tag),
    );
    expect(MIGRATIONS.map((migration) => [...migration.statements])).toEqual(
      onDisk.map((migration) => migration.statements),
    );
  });
});
