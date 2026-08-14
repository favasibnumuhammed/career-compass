/**
 * `GET /api/search?q=…&kind=skill|occupation&limit=…` — Q0 and Q1.
 *
 * Both doors of the entry screen are typeaheads, and they differ only in what
 * they search, so they share a route. Fires on every keystroke, so it is the
 * one endpoint where latency is felt directly: the client must debounce, and
 * queries shorter than two characters return an empty list without touching the
 * database at all.
 */
import type { NextRequest } from "next/server";
import { badRequest, CACHE_LOOKUP, fail, ok, readLimit } from "@/lib/api";
import { searchOccupations, searchSkills } from "@/lib/queries";
import type { OccupationSuggestion, SkillSuggestion } from "@/lib/types";

interface SearchResponse {
  kind: "skill" | "occupation";
  query: string;
  results: SkillSuggestion[] | OccupationSuggestion[];
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const query = params.get("q") ?? "";
    const kind = params.get("kind") ?? "skill";
    const limit = readLimit(params.get("limit"), 10, 50);

    if (kind !== "skill" && kind !== "occupation") {
      throw badRequest('kind must be "skill" or "occupation".', "kind");
    }

    const results =
      kind === "skill" ? await searchSkills(query, limit) : await searchOccupations(query, limit);

    return ok<SearchResponse>({ kind, query, results }, CACHE_LOOKUP);
  } catch (error) {
    return fail(error, "GET /api/search");
  }
}
