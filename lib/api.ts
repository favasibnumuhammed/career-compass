/**
 * The HTTP error contract, in one place so every route obeys it identically.
 *
 * From PLAN.md §6: **404** unknown occupation · **503** database unreachable ·
 * **500** everything else. The UI has to tell "we don't have that" apart from
 * "we can't reach the database" — they are different panels, and only one of
 * them gets a retry button.
 *
 * Every response carries a machine-readable `code`, because the UI switches on
 * it and matching against prose breaks the moment someone rewrites a sentence.
 */
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { DbAuthError, DbQueryError, DbUnreachableError } from "./db";
import { EnvError } from "./env";

export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "db_unreachable"
  | "db_auth"
  | "misconfigured"
  | "internal";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present on `bad_request`: which field was wrong. */
    field?: string;
  };
}

/** Thrown by routes for the cases only they can detect. */
export class ApiError extends Error {
  constructor(
    readonly code: Extract<ApiErrorCode, "bad_request" | "not_found">,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string, field?: string): ApiError {
  return new ApiError("bad_request", message, field);
}

export function notFound(message = "We don't have that in the graph."): ApiError {
  return new ApiError("not_found", message);
}

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  db_unreachable: 503,
  db_auth: 500,
  misconfigured: 500,
  internal: 500,
};

/**
 * Turn anything thrown inside a route into the response for it.
 *
 * Messages are written for the person looking at the screen, and **nothing
 * from the driver reaches them**. A `DbQueryError` carries the failing Cypher;
 * putting that on the wire would leak the schema and read like a crash report.
 * It goes to the server log, where it is useful, and the client gets a
 * sentence.
 */
export function fail(error: unknown, context: string): NextResponse<ApiErrorBody> {
  const { code, message } = classifyError(error);

  // 5xx is a bug or an outage; either way someone needs the detail. 4xx is the
  // caller's doing and is already fully described by the response.
  if (STATUS[code] >= 500) {
    console.error(`[${context}] ${code}:`, error);
  }

  const field = error instanceof ApiError ? error.field : undefined;
  return NextResponse.json({ error: { code, message, ...(field ? { field } : {}) } }, { status: STATUS[code] });
}

/**
 * The single place a thrown thing becomes a code and a sentence.
 *
 * Exported because the UI needs the same mapping without the HTTP response
 * around it: the pages render from `lib/queries.ts` directly (see `lib/load.ts`)
 * and must show the *same* message the API would have returned for the same
 * failure. One contract, two transports — the alternative is a second set of
 * wordings that drift.
 */
export function classifyError(error: unknown): { code: ApiErrorCode; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DbUnreachableError) {
    return {
      code: "db_unreachable",
      message: "Can't reach the graph database right now. It may be starting up — try again in a moment.",
    };
  }
  if (error instanceof DbAuthError) {
    return {
      code: "db_auth",
      message: "The graph database rejected this server's credentials.",
    };
  }
  if (error instanceof EnvError) {
    return {
      code: "misconfigured",
      message: "This server has no database connection configured.",
    };
  }
  if (error instanceof DbQueryError) {
    return { code: "internal", message: "Something went wrong running that query." };
  }
  return { code: "internal", message: "Something went wrong." };
}

/* -------------------------------------------------------------------------- */
/* Success responses                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ESCO is a committed static snapshot, so lookups are safely cacheable for a
 * while; a typeahead firing on every keystroke is the main beneficiary.
 * Personalised analysis is not cached — it is derived from the user's own skill
 * set, and it does not belong in a shared cache.
 */
export const CACHE_LOOKUP = "public, max-age=60, stale-while-revalidate=300";
export const CACHE_NONE = "no-store";

export function ok<T>(data: T, cache: string = CACHE_NONE): NextResponse<T> {
  return NextResponse.json(data, { headers: { "Cache-Control": cache } });
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parse and validate a JSON body, turning both a malformed body and a
 * well-formed but wrong one into a 400 rather than a 500.
 *
 * Uses zod because `lib/env.ts` does: untrusted input gets a schema, and the
 * schema is the documentation.
 */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join(".") || undefined;
    throw badRequest(`${field ? `${field}: ` : ""}${issue.message}`, field);
  }
  return parsed.data;
}

/** Clamp a `?limit=` to something the database is willing to do all day. */
export function readLimit(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw badRequest("limit must be a positive number.", "limit");
  return Math.min(Math.floor(parsed), max);
}
