/**
 * `POST /api/path` — Q5, the career route from one job to another.
 *
 * **"No route exists" is an answer, not an error.** It comes back as `200` with
 * `path: null` and a reason, because five occupations have no similarity edge
 * at all and plenty of pairs are more than six hops apart. A 404 there would be
 * a lie: we have both occupations, they are simply not connected.
 *
 * A 404 is reserved for an occupation we genuinely do not have — which is why
 * both endpoints are resolved up front rather than inferred from a null path.
 * Without that lookup the two cases are indistinguishable, and the UI would
 * tell someone their career is a dead end when the truth is a stale link.
 */
import { z } from "zod";
import { badRequest, fail, notFound, ok, readJson } from "@/lib/api";
import { occupationUri, skillUris } from "@/lib/esco";
import { careerPath, occupationRefs } from "@/lib/queries";
import type { PathResult } from "@/lib/types";

const body = z.object({
  from: z.string(),
  to: z.string(),
  /** Optional. Without it, hops are costed against the starting job's skills. */
  skills: z.array(z.string()).max(300).optional(),
});

export async function POST(request: Request) {
  try {
    const input = await readJson(request, body);

    const from = occupationUri(input.from);
    if (!from) throw badRequest("That is not a valid occupation id.", "from");
    const to = occupationUri(input.to);
    if (!to) throw badRequest("That is not a valid occupation id.", "to");

    const refs = await occupationRefs(from === to ? [from] : [from, to]);
    if (!refs.has(from)) throw notFound("We don't have the occupation you're starting from.");
    if (!refs.has(to)) throw notFound("We don't have the occupation you're heading for.");

    const path = await careerPath(from, to, { skills: skillUris(input.skills ?? []) });

    return ok<PathResult>({
      from: { uri: from, label: refs.get(from)! },
      to: { uri: to, label: refs.get(to)! },
      path,
      ...(path ? {} : { reason: "unreachable" as const }),
    });
  } catch (error) {
    return fail(error, "POST /api/path");
  }
}
