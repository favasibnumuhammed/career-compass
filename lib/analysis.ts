/**
 * The whole answer to "what can I do with these skills?", assembled once.
 *
 * Lifted out of `app/api/analyze/route.ts` in Phase 5 so the results page and
 * the HTTP endpoint run *the same* work. The orchestration here is not
 * incidental — it is the measured shape from PLAN.md §13, and having two copies
 * of it would mean the page and the endpoint drifting to different latencies
 * and, worse, different tier cut-offs.
 *
 * **Why the queries are issued the way they are.** In sequence on the c0
 * instance: ranking 3.1s, bridge skills 4.0s, rollup 1.5s — 8.6s. Overlapped as
 * far as the dependencies allow, the median is ~7.5s, nowhere near
 * `max(3.1, 4.0) + 1.5`, because a 0.5 vCPU instance largely serialises the
 * work no matter how many connections it is asked over. Issuing the ranking and
 * the bridge query together saves ~1s; chaining the rollup onto the ranking so
 * it overlaps the bridge query's tail saves ~0.4s more. Concurrency buys ~15%,
 * not a speedup — which is why the UI is built around seven seconds rather than
 * around hiding them.
 */
import { bridgeSkills, gapRollup, rankRoles } from "./queries";
import type { AnalysisResult } from "./types";

/** Tier 2 is "at least halfway there". */
export const WITHIN_REACH = 0.5;

export interface AnalyseOptions {
  /** How many roles to rank. Tier 2 is a slice of the same list. */
  limit?: number;
  /** How many roles the bridge-skill question is asked over — the denominator. */
  pool?: number;
  /**
   * Occupations to leave out — in practice the job the user started from,
   * which would otherwise top its own results at 100% and tell them nothing.
   */
  exclude?: readonly string[];
}

export async function analyse(
  skills: string[],
  options: AnalyseOptions = {},
): Promise<AnalysisResult> {
  const { limit = 24, pool = 100, exclude = [] } = options;
  const excluded = [...exclude];

  const rankingDone = rankRoles(skills, { limit, exclude: excluded });

  // Every distinct skill standing between the user and the roles they are
  // closest to — the input to the theme rollup. Chained onto the ranking so it
  // starts the moment its input exists, overlapping the bridge query rather
  // than queueing behind it.
  const rollupDone = rankingDone.then((ranked) => {
    const gaps = [...new Set(ranked.flatMap((role) => role.missing.map((skill) => skill.uri)))];
    return gapRollup(gaps).then((themes) => ({ gaps: gaps.length, themes }));
  });

  const [ranked, bridges, rollup] = await Promise.all([
    rankingDone,
    bridgeSkills(skills, { pool, exclude: excluded }),
    rollupDone,
  ]);

  return {
    closest: ranked,
    withinReach: ranked.filter((role) => role.coverage >= WITHIN_REACH),
    bridges,
    themes: rollup.themes,
    meta: { skills: skills.length, gaps: rollup.gaps },
  };
}
