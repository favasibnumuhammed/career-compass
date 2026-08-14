/**
 * The user's answer, carried in the URL.
 *
 * The skill set is the only state this app has, and it is needed on three
 * screens: the results, the occupation detail (to mark skills have/missing) and
 * the career path. Keeping it in the URL rather than in a store means refresh
 * works, back and forward work, and a reviewer can paste a link into a bug
 * report and see exactly what the reporter saw.
 *
 * That is affordable only because of Phase 4's short ids (PLAN.md §13): a
 * seventeen-skill set is ~630 characters as UUIDs and ~1,600 as full ESCO URIs.
 * `lib/esco.ts` accepts either form back, so a hand-edited link with full URIs
 * in it still works.
 */
import { escoId, occupationUri, skillUris } from "./esco";

/** `?s=` — the user's skills. `?from=` — the job they started from, if any. */
export const SKILLS_PARAM = "s";
export const FROM_PARAM = "from";

/** Anything Next hands you for one search param, normalised to a list of ids. */
type Raw = string | string[] | undefined;

function split(raw: Raw): string[] {
  if (raw === undefined) return [];
  const joined = Array.isArray(raw) ? raw.join(",") : raw;
  return joined
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Read `?s=` into full skill URIs, dropping anything malformed.
 *
 * Silent dropping matches the API (`lib/esco.ts`): a stale bookmark should
 * still answer with the skills it can read rather than refuse the whole page.
 */
export function readSkills(raw: Raw): string[] {
  return skillUris(split(raw));
}

/** Read `?from=` into a full occupation URI, or `null`. */
export function readFrom(raw: Raw): string | null {
  const [first] = split(raw);
  return first ? occupationUri(first) : null;
}

/** Build the query string every internal link carries. */
export function contextQuery(skills: readonly string[], from?: string | null): string {
  const params = new URLSearchParams();
  if (skills.length > 0) params.set(SKILLS_PARAM, skills.map(escoId).join(","));
  if (from) params.set(FROM_PARAM, escoId(from));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function resultsHref(skills: readonly string[], from?: string | null): string {
  return `/results${contextQuery(skills, from)}`;
}

export function occupationHref(
  uri: string,
  skills: readonly string[] = [],
  from?: string | null,
): string {
  return `/occupation/${escoId(uri)}${contextQuery(skills, from)}`;
}
