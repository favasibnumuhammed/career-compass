/**
 * How the pages get their data.
 *
 * **Server Components call `lib/queries.ts` directly rather than fetching this
 * app's own HTTP routes.** A page issuing `fetch("http://localhost:3000/api/…")`
 * would serialise a 200 KB analysis through the loopback, pay a second round
 * trip on a box that has half a core to spare, and force every page to
 * reconstruct the error contract from a status code it had just finished
 * encoding. The routes from Phase 4 are the app's *public* surface — exercised
 * end to end by `npm run api`, and the thing a client other than this UI would
 * call. The UI is not such a client. The one exception is the typeahead, which
 * runs in the browser on every keystroke and genuinely needs `/api/search`.
 *
 * **Failures are values, not exceptions.** Throwing would route through
 * `error.tsx`, and React strips a Server Component error's message in
 * production, replacing it with a digest — so the one thing the plan is
 * explicit about (a database-unreachable panel that reads differently from "no
 * results", §5) would degrade to "something went wrong" in the deployment that
 * matters. Returning the classification instead keeps the distinction on the
 * screen, and it comes from `classifyError` — the same function the API routes
 * use, so a given failure reads identically whichever way it is reached.
 */
import { classifyError, type ApiErrorCode } from "./api";

export interface LoadFailure {
  code: ApiErrorCode;
  message: string;
}

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: LoadFailure };

/** The failure a page raises itself when the graph simply has no such thing. */
export const NOT_FOUND: LoadFailure = {
  code: "not_found",
  message: "We don't have that occupation.",
};

/**
 * Run a query, and hand back either its result or the classified failure.
 *
 * `context` names the caller in the server log; nothing from the driver reaches
 * the browser, for the reasons `lib/api.ts` gives.
 */
export async function load<T>(context: string, work: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    const failure = classifyError(error);
    if (failure.code !== "not_found" && failure.code !== "bad_request") {
      console.error(`[${context}] ${failure.code}:`, error);
    }
    return { ok: false, error: failure };
  }
}

/** `load`, for a query that answers `null` when it does not have the thing. */
export async function loadOne<T>(
  context: string,
  work: () => Promise<T | null>,
): Promise<Loaded<T>> {
  const result = await load(context, work);
  if (!result.ok) return result;
  return result.data === null ? { ok: false, error: NOT_FOUND } : { ok: true, data: result.data };
}
