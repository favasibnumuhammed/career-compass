/**
 * `GET /api/occupation/<id>/prefill` — the second half of Q1.
 *
 * The occupation plus the essential skills that become editable chips when
 * someone picks "start from a job you've done". **This is the door that makes
 * the app usable by a person who would never volunteer a list of skills**, so
 * it is kept separate from the detail route rather than served as a subset of
 * it: it sits on the landing page, it blocks the user, and it has no business
 * shipping forty skills and eight neighbours to render seventeen chips.
 */
import { CACHE_LOOKUP, badRequest, fail, notFound, ok } from "@/lib/api";
import { occupationUri } from "@/lib/esco";
import { occupationPrefill } from "@/lib/queries";
import type { OccupationPrefill } from "@/lib/types";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    const uri = occupationUri(id);
    if (!uri) throw badRequest("That is not a valid occupation id.", "id");

    const prefill = await occupationPrefill(uri);
    if (!prefill) throw notFound("We don't have that occupation.");

    return ok<OccupationPrefill>(prefill, CACHE_LOOKUP);
  } catch (error) {
    return fail(error, "GET /api/occupation/[id]/prefill");
  }
}
