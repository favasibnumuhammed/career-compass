/**
 * `GET /api/occupation/<id>?skills=…` — Q6, the occupation detail page.
 *
 * `id` is the short form (the ESCO UUID); a full URI is accepted too. See
 * `lib/esco.ts` for why both.
 *
 * `?skills=` is a comma-separated list of the user's skills. With it, every
 * skill in the response is marked have/missing and `coverage` is a number; without
 * it, `coverage` is `null` rather than 0 — "we don't know" and "you have none
 * of this" are different things, and a progress ring at 0% is a lie about the
 * first one.
 *
 * This is the route that gives the plan's 404 its meaning: an occupation we do
 * not have is **not** the same as a database we cannot reach, and the two get
 * different screens.
 */
import type { NextRequest } from "next/server";
import { badRequest, CACHE_LOOKUP, fail, notFound, ok } from "@/lib/api";
import { occupationUri, skillUris } from "@/lib/esco";
import { occupationDetail } from "@/lib/queries";
import type { OccupationDetail } from "@/lib/types";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    const uri = occupationUri(id);
    if (!uri) throw badRequest("That is not a valid occupation id.", "id");

    const raw = request.nextUrl.searchParams.get("skills");
    const skills = skillUris(raw ? raw.split(",") : []);

    const detail = await occupationDetail(uri, skills);
    if (!detail) throw notFound("We don't have that occupation.");

    return ok<OccupationDetail>(detail, skills.length === 0 ? CACHE_LOOKUP : "no-store");
  } catch (error) {
    return fail(error, "GET /api/occupation/[id]");
  }
}
