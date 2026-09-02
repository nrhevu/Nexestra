import type { ApiError } from "@nexestra/core";
import { NotFoundError } from "@nexestra/storage";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export type ApiErrorCode = ApiError["error"]["code"];

/** Anything the API rejects on purpose; `app.onError` renders it as JSON. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "bad_request", message, details);

export const notFound = (message: string) => new HttpError(404, "not_found", message);

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, "conflict", message, details);

/** Parse a JSON body through a zod schema, or fail with `bad_request`. */
export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("request body failed validation", z.treeifyError(parsed.error));
  }
  return parsed.data;
}

/** Fail with 400 when a required query parameter is missing. */
export function requireQuery(c: Context, name: string): string {
  const value = c.req.query(name);
  if (!value) throw badRequest(`query parameter "${name}" is required`);
  return value;
}

/** Return `value` or fail with 404. */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw notFound(`${what} not found`);
  return value;
}

/** Single place every `/api/*` failure is rendered from. */
export function renderError(error: unknown, c: Context): Response {
  if (error instanceof HttpError) {
    const payload: ApiError = {
      error: { code: error.code, message: error.message, details: error.details },
    };
    return c.json(payload, error.status);
  }
  if (error instanceof NotFoundError) {
    const payload: ApiError = { error: { code: "not_found", message: error.message } };
    return c.json(payload, 404);
  }
  const payload: ApiError = {
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : "unexpected server error",
    },
  };
  return c.json(payload, 500);
}
