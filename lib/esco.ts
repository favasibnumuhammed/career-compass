/**
 * ESCO identifiers at the HTTP boundary.
 *
 * The graph's identity is the full ESCO URI —
 * `http://data.europa.eu/esco/occupation/a79d9e58-36be-4e67-a4db-ea6c8ff445fc`
 * — and `lib/queries.ts` speaks nothing else. That does not fit in a URL path
 * segment without double-encoding, and a results link carrying seventeen of
 * them is 1,000 characters long.
 *
 * Every occupation and skill in the snapshot uses the same two prefixes with a
 * UUID on the end (verified: 2,909 of 2,909 and 13,201 of 13,201), so the UUID
 * alone is a lossless short form.
 *
 * The API therefore accepts **either form** anywhere it takes an identifier and
 * normalises here. Responses keep the full `uri`, because that is the honest
 * identifier and it dereferences — paste one into a browser and ESCO serves the
 * concept. The UI can put short ids in its own URLs and hand them straight
 * back.
 */

const OCCUPATION_PREFIX = "http://data.europa.eu/esco/occupation/";
const SKILL_PREFIX = "http://data.europa.eu/esco/skill/";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalise(value: string, prefix: string): string | null {
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return prefix + trimmed.toLowerCase();
  if (trimmed.startsWith(prefix) && UUID.test(trimmed.slice(prefix.length))) {
    return prefix + trimmed.slice(prefix.length).toLowerCase();
  }
  return null;
}

/** A UUID or a full occupation URI → the URI. `null` if it is neither. */
export function occupationUri(value: string): string | null {
  return normalise(value, OCCUPATION_PREFIX);
}

/** A UUID or a full skill URI → the URI. `null` if it is neither. */
export function skillUri(value: string): string | null {
  return normalise(value, SKILL_PREFIX);
}

/**
 * The short form: the last path segment. Used by the UI to build links and
 * compact query strings.
 *
 * Deliberately not restricted to UUIDs — skill *groups* are `.../skill/S2.6.1`,
 * and this stays correct for them even though they are never accepted as input.
 */
export function escoId(uri: string): string {
  const cut = uri.lastIndexOf("/");
  return cut === -1 ? uri : uri.slice(cut + 1);
}

/**
 * Normalise a list, dropping anything malformed.
 *
 * Silent dropping is right for skills: they arrive from our own typeahead, a
 * stale bookmark should still return the best answer it can rather than a 400,
 * and a bad URI cannot match anything in the graph anyway. Single identifiers
 * that name the *subject* of a request — the occupation on a detail page — are
 * validated strictly by the routes instead.
 */
export function skillUris(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const uri = skillUri(value);
    if (uri) seen.add(uri);
  }
  return [...seen];
}
