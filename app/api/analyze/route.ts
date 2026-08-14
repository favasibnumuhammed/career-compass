/**
 * `POST /api/analyze` — Q2, Q3, Q4 and Q7 as **one payload**.
 *
 * The three result tiers and the gap rollup are one thought: "here is where you
 * stand, and here is the single thing to learn next." Four round trips against
 * a burstable half-core would render the page in stages for no benefit, so the
 * whole answer arrives at once and the UI shows one set of skeletons.
 *
 * `POST` rather than `GET` because the input is a list that can run to a couple
 * of hundred skills, which does not belong in a URL. The cost is that the
 * response is not cacheable — correct anyway, since it is derived entirely from
 * one person's skill set.
 *
 * **Shape of the work, measured rather than assumed.** In sequence on the c0
 * instance: ranking 3.1s, bridge skills 4.0s, rollup 1.5s — 8.6s. With all
 * three overlapped as far as their dependencies allow, the endpoint's median is
 * **~7.5s**.
 *
 * That is nothing like `max(3.1, 4.0) + 1.5`, and the reason is worth stating:
 * **a 0.5 vCPU instance largely serialises the work no matter how many
 * connections it is asked over.** Issuing the ranking and the bridge query
 * together saves about a second, not three, and chaining the rollup onto the
 * ranking — so it overlaps the bridge query's tail instead of queueing behind
 * it — saves about another half. Concurrency here buys ~15%, not a speedup.
 *
 * Phase 5 has to design for seven seconds: skeletons shaped like the real
 * content, and results that appear as one complete answer rather than a page
 * that rearranges itself. See PLAN.md §13 for the two faster designs that were
 * measured and rejected.
 *
 * The orchestration itself lives in `lib/analysis.ts`, because Phase 5's
 * results page runs the same work in-process and the two must not drift.
 */
import { z } from "zod";
import { badRequest, fail, ok, readJson } from "@/lib/api";
import { analyse } from "@/lib/analysis";
import { occupationUri, skillUris } from "@/lib/esco";
import type { AnalysisResult } from "@/lib/types";

const body = z.object({
  /** The user's skills, as ESCO UUIDs or full URIs. */
  skills: z.array(z.string()).min(1, "pick at least one skill").max(300),
  /**
   * Occupations to leave out of the results — in practice the job the user
   * started from, which would otherwise sit at the top of its own results at
   * 100% coverage and tell them nothing.
   */
  exclude: z.array(z.string()).max(50).optional(),
  /** How many roles to rank. Tier 2 is a slice of the same list. */
  limit: z.number().int().min(1).max(50).optional(),
  /** How many roles the bridge-skill question is asked over. */
  pool: z.number().int().min(10).max(300).optional(),
});

export async function POST(request: Request) {
  try {
    const input = await readJson(request, body);

    const skills = skillUris(input.skills);
    if (skills.length === 0) {
      throw badRequest("None of those look like ESCO skill identifiers.", "skills");
    }

    // Malformed exclusions are dropped rather than rejected: they only ever
    // remove noise from the results, so a bad one costs nothing.
    const exclude = (input.exclude ?? [])
      .map(occupationUri)
      .filter((uri): uri is string => uri !== null);

    const result = await analyse(skills, {
      limit: input.limit,
      pool: input.pool,
      exclude,
    });

    return ok<AnalysisResult>(result);
  } catch (error) {
    return fail(error, "POST /api/analyze");
  }
}
