import { defineConfig } from "drizzle-kit";

/**
 * `pnpm --filter @nexestra/storage db:generate` regenerates `drizzle/` from
 * `src/schema.ts` and then embeds the SQL into `src/migrations.ts`, which is
 * what the runtime actually applies (see `src/db.ts`).
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  strict: true,
});
