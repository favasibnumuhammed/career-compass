/**
 * Phase 3: every Cypher statement in the application lives here.
 *
 * Three rules hold throughout, and each one is load-bearing on the free tier:
 *
 *  1. **Everything is parameterised.** No user value is ever spliced into a
 *     query string. That is the injection boundary, and it lets the server
 *     reuse a plan across calls.
 *
 *  2. **Never scan all occupations.** Every query anchors on an indexed lookup
 *     — the user's skill URIs, an occupation URI, a label prefix — and expands
 *     outward. Ranking happens after a `LIMIT`, never before.
 *
 *  3. **Filter relationship properties in `WHERE`, never in the pattern.**
 *     CognoDB silently *drops* a relationship property map written inside an
 *     `OPTIONAL MATCH` pattern — `OPTIONAL MATCH (o)-[:REQUIRES {essential:
 *     true}]->(s)` returns essential *and* optional skills, with no error (see
 *     PLAN.md §11). `WHERE r.essential = true` is correct in both positions, so
 *     it is used in both positions rather than relying on remembering which is
 *     which.
 *
 * The instance also enforces a **5-second BFS budget**, which shapes Q4 (pool
 * the candidates before expanding them) and Q5 (see `careerPath`).
 */
import { runRead } from "./db";
import type {
  BridgeSkill,
  BridgeSkillResult,
  CareerPath,
  DetailSkill,
  GapTheme,
  Neighbour,
  OccupationDetail,
  OccupationPrefill,
  OccupationSuggestion,
  PathHop,
  PathStep,
  RoleMatch,
  SkillRef,
  SkillSuggestion,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Q0 — skill typeahead                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prefix search over skills, ranked by how many occupations require the skill
 * as essential.
 *
 * Demand ranking is what makes the typeahead usable: typing "man" should offer
 * `manage staff` (242 occupations) before `manage aquatic production stock`
 * (1). It is counted per query rather than denormalised onto the node because
 * the prefix has already cut the candidate set to a few hundred skills, and a
 * count over those costs nothing measurable.
 *
 * ESCO labels are lower-case, so the query is lower-cased and matched directly
 * against `Skill.label` — which keeps the property index in play. A
 * `toLower(s.label)` would not. `altLabels` are matched too, so "HR" finds
 * `manage human resources`; that arm is a scan over 13k nodes, which measured
 * at ~1.1s worst case and is the reason the search route should debounce.
 */
export async function searchSkills(query: string, limit = 10): Promise<SkillSuggestion[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  return runRead<SkillSuggestion>(
    `MATCH (s:Skill)
     WHERE s.label STARTS WITH $q OR any(a IN s.altLabels WHERE toLower(a) STARTS WITH $q)
     OPTIONAL MATCH (:Occupation)-[r:REQUIRES]->(s)
     WHERE r.essential = true
     WITH s, count(r) AS demand
     RETURN s.uri        AS uri,
            s.label      AS label,
            s.skillType  AS skillType,
            s.reuseLevel AS reuseLevel,
            demand
     // Direct label matches before synonym matches, then by demand. Without the
     // first key a high-demand synonym match outranks the thing actually typed.
     ORDER BY CASE WHEN s.label STARTS WITH $q THEN 0 ELSE 1 END, demand DESC, s.label
     LIMIT $limit`,
    { q, limit: Math.max(1, Math.min(limit, 50)) },
  );
}

/* -------------------------------------------------------------------------- */
/* Q1 — occupation typeahead, and the prefill behind it                        */
/* -------------------------------------------------------------------------- */

/**
 * Prefix search over occupations — the first of the app's two doors.
 *
 * `altLabels` matter more here than in Q0: ESCO's preferred label is
 * `retail department manager`, but the person looking for it will type "shop
 * manager" or "store manager". Only 2,909 nodes, so the scan arm is cheap.
 */
export async function searchOccupations(query: string, limit = 10): Promise<OccupationSuggestion[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  return runRead<OccupationSuggestion>(
    `MATCH (o:Occupation)
     WHERE o.label STARTS WITH $q OR any(a IN o.altLabels WHERE toLower(a) STARTS WITH $q)
     RETURN o.uri            AS uri,
            o.label          AS label,
            o.iscoGroupLabel AS iscoGroupLabel,
            o.essentialCount AS essentialCount,
            o.optionalCount  AS optionalCount,
            head([a IN o.altLabels WHERE toLower(a) STARTS WITH $q]) AS matchedAlt
     // "shop" must offer *shop* manager before betting manager, whose synonym
     // list happens to contain "shop manager". Label matches first, always.
     ORDER BY CASE WHEN o.label STARTS WITH $q THEN 0 ELSE 1 END, o.label
     LIMIT $limit`,
    { q, limit: Math.max(1, Math.min(limit, 50)) },
  );
}

/**
 * "Start from a job you've done": the chosen occupation plus the essential
 * skills that prefill the skill editor as editable chips.
 *
 * This is the door that makes the app usable by someone who would never
 * volunteer a list of skills — the point of the whole entry design.
 *
 * Returns `null` for an unknown URI so the API layer can answer 404 rather than
 * an empty 200.
 */
export async function occupationPrefill(uri: string): Promise<OccupationPrefill | null> {
  if (!uri) return null;

  const rows = await runRead<{
    occupation: OccupationSuggestion;
    essentialSkills: SkillRef[];
  }>(
    `MATCH (o:Occupation {uri: $uri})
     OPTIONAL MATCH (o)-[r:REQUIRES]->(s:Skill)
     WHERE r.essential = true
     WITH o, [x IN collect({uri: s.uri, label: s.label, skillType: s.skillType})
              WHERE x.uri IS NOT NULL] AS essentialSkills
     RETURN {
              uri: o.uri, label: o.label, iscoGroupLabel: o.iscoGroupLabel,
              essentialCount: o.essentialCount, optionalCount: o.optionalCount
            } AS occupation,
            essentialSkills`,
    { uri },
  );

  const row = rows[0];
  if (!row) return null;
  return {
    occupation: row.occupation,
    essentialSkills: [...row.essentialSkills].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * Which of these occupations exist, with their labels.
 *
 * Exists so a route can answer 404 for an occupation we do not have. Without
 * it, "no such occupation" and "no route between these two" both surface as a
 * null path, and the UI would tell someone their career is a dead end when the
 * truth is a stale bookmark.
 */
export async function occupationRefs(uris: string[]): Promise<Map<string, string>> {
  if (uris.length === 0) return new Map();

  const rows = await runRead<{ uri: string; label: string }>(
    `MATCH (o:Occupation) WHERE o.uri IN $uris RETURN o.uri AS uri, o.label AS label`,
    { uris },
  );
  return new Map(rows.map((row) => [row.uri, row.label]));
}

/**
 * The same, for skills — the labels behind a `?s=` query string.
 *
 * Added in Phase 5. The UI carries the user's skill set in the URL as bare
 * ESCO ids so links are shareable and refreshable, which means "edit your
 * skills" arrives at the entry screen holding seventeen identifiers and no
 * words. This turns them back into chips.
 *
 * Rows come back in `$uris` order rather than the graph's, so re-entering the
 * editor shows the skills in the order they were picked instead of reshuffling
 * them, which would read as data loss.
 */
export async function skillRefs(uris: string[]): Promise<SkillRef[]> {
  if (uris.length === 0) return [];

  const rows = await runRead<SkillRef>(
    `MATCH (s:Skill) WHERE s.uri IN $uris
     RETURN s.uri AS uri, s.label AS label, s.skillType AS skillType`,
    { uris },
  );

  const byUri = new Map(rows.map((row) => [row.uri, row]));
  return uris.map((uri) => byUri.get(uri)).filter((row): row is SkillRef => row !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Q2 / Q3 — how close am I to every role worth considering                    */
/* -------------------------------------------------------------------------- */

/**
 * The two-hop core of the results page: **my skills → occupations requiring
 * them → those occupations' other essential skills.**
 *
 * `have` comes from the anchored traversal; `total` is read off the node
 * (`essentialCount`, denormalised at seed time). That subtraction is the whole
 * reason this query returns in ~2s instead of tripping the BFS budget —
 * deriving `total` in Cypher means collecting every candidate's full skill
 * list before you have narrowed anything down.
 *
 * The expansion to the missing skills themselves happens **after** the `LIMIT`,
 * so it touches `limit` occupations rather than the ~1,500 that share at least
 * one skill with a typical user.
 *
 * Tiers are cut from one call: Phase 4 should call this once with a generous
 * limit and slice, not twice.
 */
export async function rankRoles(
  skills: string[],
  options: { limit?: number; minCoverage?: number; exclude?: string[] } = {},
): Promise<RoleMatch[]> {
  if (skills.length === 0) return [];

  const { limit = 24, minCoverage = 0, exclude = [] } = options;

  const rows = await runRead<Omit<RoleMatch, "gap"> & { missing: SkillRef[] }>(
    `MATCH (s:Skill)<-[r:REQUIRES]-(o:Occupation)
     WHERE s.uri IN $skills AND r.essential = true AND NOT o.uri IN $exclude
     WITH o, count(s) AS have
     WHERE o.essentialCount > 0
     WITH o, have, toFloat(have) / o.essentialCount AS coverage
     WHERE coverage >= $minCoverage
     // Ranking gets its own WITH: openCypher only accepts ORDER BY directly on
     // the projection, so a filtered projection has to be re-projected first.
     WITH o, have, coverage
     ORDER BY coverage DESC, have DESC, o.label
     LIMIT $limit
     OPTIONAL MATCH (o)-[r2:REQUIRES]->(m:Skill)
     WHERE r2.essential = true AND NOT m.uri IN $skills
     WITH o, have, coverage,
          [x IN collect({uri: m.uri, label: m.label, skillType: m.skillType})
           WHERE x.uri IS NOT NULL] AS missing
     RETURN o.uri            AS uri,
            o.label          AS label,
            o.iscoGroupLabel AS iscoGroupLabel,
            have,
            o.essentialCount AS total,
            coverage,
            missing
     ORDER BY coverage DESC, have DESC, o.label`,
    { skills, exclude, minCoverage, limit: Math.max(1, Math.min(limit, 200)) },
  );

  return rows.map((row) => ({
    ...row,
    gap: row.total - row.have,
    missing: [...row.missing].sort((a, b) => a.label.localeCompare(b.label)),
  }));
}

/** Q2 — **Closest roles**: the best matches, whatever their coverage. */
export function closestRoles(skills: string[], limit = 12, exclude: string[] = []) {
  return rankRoles(skills, { limit, exclude });
}

/**
 * Q3 — **Within reach**: roles the user is at least halfway to.
 *
 * Often empty, and that is a real answer rather than a bug — for a narrow skill
 * set nothing clears 50%. The UI has an empty state for it that says so.
 */
export function withinReach(skills: string[], limit = 12, exclude: string[] = []) {
  return rankRoles(skills, { limit, minCoverage: 0.5, exclude });
}

/* -------------------------------------------------------------------------- */
/* Q4 — bridge skills, the hero                                                */
/* -------------------------------------------------------------------------- */

/**
 * **Which single skill should I learn next?**
 *
 * The plan's formulation — "occupations blocked by exactly one essential skill
 * I lack" — returns empty on real ESCO data, for everyone. ESCO gives each
 * occupation a distinctive essential set; the minimum gap between a role and
 * its nearest neighbour is around six skills (PLAN.md §11). Nothing is one
 * skill away.
 *
 * So the question is asked with an honest denominator instead: **among the N
 * roles you are closest to, which single skill appears in the most gaps?**
 * That yields "learn `maintain relationship with customers` → advances 56 of
 * your 100 nearest roles", with the roles named — real leverage, no invented
 * arithmetic.
 *
 * `completes` keeps the original question alive as a column: how many of those
 * roles the skill would finish outright. It is 0 on this data, and reporting
 * that is better than hiding the fact we looked.
 *
 * The pooling matters for more than honesty: expanding *every* candidate's
 * skill list is what trips the 5-second BFS budget. `LIMIT $pool` before the
 * second `MATCH` is what keeps this at ~2s.
 */
export async function bridgeSkills(
  skills: string[],
  options: { pool?: number; limit?: number; exclude?: string[] } = {},
): Promise<BridgeSkillResult> {
  if (skills.length === 0) return { skills: [], pool: 0 };

  const { pool = 100, limit = 8, exclude = [] } = options;

  // Two round trips, run together: the c0 instance charges ~0.85s of latency
  // before either does any work, and they share no state.
  const [rows, poolRows] = await Promise.all([
    runRead<BridgeSkill & { examples: string[] }>(
      `MATCH (s:Skill)<-[r:REQUIRES]-(o:Occupation)
     WHERE s.uri IN $skills AND r.essential = true AND NOT o.uri IN $exclude
     WITH o, count(s) AS have
     // Roles the user already fully covers have nothing left to unlock.
     WHERE o.essentialCount > have
     WITH o, have, toFloat(have) / o.essentialCount AS coverage
     ORDER BY coverage DESC, o.label
     LIMIT $pool
     MATCH (o)-[r2:REQUIRES]->(m:Skill)
     WHERE r2.essential = true AND NOT m.uri IN $skills
     WITH m, o, coverage, o.essentialCount - have AS gap
     // Closest roles first, so the collected examples name the most relevant ones.
     ORDER BY coverage DESC, o.label
     WITH m,
          count(o)                                       AS advances,
          sum(CASE WHEN gap = 1 THEN 1 ELSE 0 END)       AS completes,
          avg(coverage)                                  AS meanCoverage,
          collect(o.label)[0..8]                         AS examples
     RETURN m.uri        AS uri,
            m.label      AS label,
            m.skillType  AS skillType,
            m.reuseLevel AS reuseLevel,
            advances, completes, meanCoverage, examples
     ORDER BY advances DESC, meanCoverage DESC, m.label
     LIMIT $limit`,
      {
        skills,
        exclude,
        pool: Math.max(1, Math.min(pool, 500)),
        limit: Math.max(1, Math.min(limit, 50)),
      },
    ),
    // The denominator the UI quotes. Counted rather than assumed: for a narrow
    // skill set fewer than `pool` roles qualify, and "56 of your 100 nearest"
    // would then be a lie.
    runRead<{ pool: number }>(
      `MATCH (s:Skill)<-[r:REQUIRES]-(o:Occupation)
       WHERE s.uri IN $skills AND r.essential = true AND NOT o.uri IN $exclude
       WITH o, count(s) AS have
       WHERE o.essentialCount > have
       RETURN count(o) AS pool`,
      { skills, exclude },
    ),
  ]);

  return {
    skills: rows,
    pool: Math.min(poolRows[0]?.pool ?? 0, Math.max(1, Math.min(pool, 500))),
  };
}

/* -------------------------------------------------------------------------- */
/* Q5 — career path                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The relationship ESCO does not ship. Traversed undirected because
 * `ADJACENT_TO` is written once per unordered pair — "nearest 15" is not
 * symmetric, so a directed edge would make paths depend on which end you
 * started from (PLAN.md §11).
 */
const LEG = `
  MATCH (a:Occupation {uri: $from}), (b:Occupation {uri: $to})
  MATCH p = shortestPath((a)-[:ADJACENT_TO*1..3]-(b))
  RETURN [n IN nodes(p) | {uri: n.uri, label: n.label, essentialCount: n.essentialCount}] AS steps,
         [r IN relationships(p) | r.jaccard] AS jaccards`;

/**
 * Every occupation within three hops, with its distance. Aggregating to
 * `min(length(p))` per node is what keeps this affordable: 792 nodes in ~1.8s,
 * where enumerating the paths themselves does not finish.
 */
const NEIGHBOURHOOD = `
  MATCH p = (a:Occupation {uri: $uri})-[:ADJACENT_TO*1..3]-(m:Occupation)
  RETURN m.uri AS uri, min(length(p)) AS d`;

interface Leg {
  steps: PathStep[];
  jaccards: number[];
}

/**
 * How many candidate routes to keep per leg before scoring. CognoDB's
 * `shortestPath` behaves like `allShortestPaths` — it returns every tied route,
 * 12 of them for the worked example — and returning all of them costs the same
 * ~1.2s as returning one. That is a gift: it means the cheapest route can be
 * *chosen* rather than stumbled into. Capped so the bidirectional case, which
 * multiplies two legs together, stays bounded.
 */
const CANDIDATES_PER_LEG = 12;

async function legs(from: string, to: string): Promise<Leg[]> {
  const rows = await runRead<Leg>(LEG, { from, to });
  return rows.slice(0, CANDIDATES_PER_LEG);
}

/**
 * **Q5 — the cheapest route from one occupation to another**, each hop a real
 * job that can be held while learning the next set of skills.
 *
 * ### Why this is not one `shortestPath` call
 *
 * It was, at first. The measurements killed it:
 *
 * | pattern | result |
 * |---|---|
 * | `shortestPath(*1..3)` | ~0.95s ✓ |
 * | `shortestPath(*1..4)` | `BFS budget exceeded (5000 ms)` ✗ |
 * | `shortestPath(*1..6)` | 20s, or the same budget error ✗ |
 *
 * Three hops reach only 792 of 2,909 occupations, so two-thirds of pairs are
 * unreachable by the query the plan called for. CognoDB also has no GDS and no
 * APOC to fall back on.
 *
 * ### What runs instead
 *
 * The textbook answer to a blown BFS budget: **search from both ends.** Two
 * depth-3 neighbourhood queries, each comfortably inside the budget, are
 * intersected in TypeScript to find the meeting point that minimises
 * `d(from,m) + d(m,to)`. Because both sides are complete to depth 3, the result
 * is the *true* shortest path for any distance up to 6 — not an approximation.
 * The two legs are then reconstructed with the depth-3 pattern that does work.
 *
 * Costs ~1.7s when the direct pattern hits, ~4.5s when it does not, against a
 * query that otherwise cannot answer at all. Both neighbourhood queries and
 * both reconstructions run in parallel.
 *
 * ### Shortest is not cheapest
 *
 * A tie on hop count is not a tie on effort. The twelve equally-short routes
 * from `retail department manager` to `supply chain manager` cost between **38
 * and 50 skills** to walk — the same three hops, a third more work — and
 * `LIMIT 1` picks among them arbitrarily. So every tied route is scored by what
 * it actually costs (see `pickCheapest`) and the cheapest is returned. The
 * candidates come back for free; only the choosing was missing.
 *
 * Returns `null` when no route exists within six hops — five occupations have
 * no `ADJACENT_TO` edge at all, and the UI says so rather than showing an empty
 * chain.
 */
export async function careerPath(
  from: string,
  to: string,
  options: { skills?: string[] } = {},
): Promise<CareerPath | null> {
  if (!from || !to) return null;

  if (from === to) {
    const rows = await runRead<PathStep>(
      `MATCH (o:Occupation {uri: $uri})
       RETURN o.uri AS uri, o.label AS label, o.essentialCount AS essentialCount`,
      { uri: from },
    );
    if (!rows[0]) return null;
    return { steps: rows, hops: [], totalLearn: 0, strategy: "direct" };
  }

  let candidates = await legs(from, to);
  let strategy: CareerPath["strategy"] = "direct";

  if (candidates.length === 0) {
    strategy = "bidirectional";
    const [fromSide, toSide] = await Promise.all([
      runRead<{ uri: string; d: number }>(NEIGHBOURHOOD, { uri: from }),
      runRead<{ uri: string; d: number }>(NEIGHBOURHOOD, { uri: to }),
    ]);

    const toDistance = new Map(toSide.map((row) => [row.uri, row.d]));
    let meeting: { uri: string; total: number } | null = null;
    for (const row of fromSide) {
      const d = toDistance.get(row.uri);
      if (d === undefined) continue;
      const total = row.d + d;
      // Tie-break on URI so the same pair always yields the same route.
      if (!meeting || total < meeting.total || (total === meeting.total && row.uri < meeting.uri)) {
        meeting = { uri: row.uri, total };
      }
    }
    if (!meeting) return null;

    const [first, second] = await Promise.all([legs(from, meeting.uri), legs(meeting.uri, to)]);

    // Every way of walking the first leg, against every way of walking the
    // second. Scoring is pure TypeScript, so breadth here is cheap.
    for (const a of first) {
      for (const b of second) {
        const steps = [...a.steps, ...b.steps.slice(1)];
        // The two legs are found independently, so one can double back through
        // a node the other already used. That is not a route anyone can walk.
        if (new Set(steps.map((step) => step.uri)).size !== steps.length) continue;
        candidates.push({ steps, jaccards: [...a.jaccards, ...b.jaccards] });
      }
    }
    if (candidates.length === 0) return null;
    candidates = candidates.slice(0, CANDIDATES_PER_LEG * CANDIDATES_PER_LEG);
  }

  return pickCheapest(candidates, strategy, options.skills ?? []);
}

/**
 * Score every tied route by what it costs to walk, and return the best one
 * annotated with the skills to acquire at each hop.
 *
 * Cost is **cumulative and deduplicated** — a skill picked up for hop 1 is not
 * charged again at hop 3. A route's real price is the union of its hops, not
 * their sum, and that is exactly what makes one tied route better than another.
 *
 * Ranked on total skills first (the "cheapest route" the product promises),
 * then on the largest single hop — between two routes of equal total, the one
 * with no punishing leap in the middle is the one a person can actually walk.
 */
async function pickCheapest(
  candidates: Leg[],
  strategy: CareerPath["strategy"],
  skills: string[],
): Promise<CareerPath> {
  const uris = [...new Set(candidates.flatMap((c) => c.steps.map((step) => step.uri)))];

  const rows = await runRead<{ uri: string; essential: SkillRef[] }>(
    `MATCH (o:Occupation)-[r:REQUIRES]->(s:Skill)
     WHERE o.uri IN $uris AND r.essential = true
     RETURN o.uri AS uri,
            collect({uri: s.uri, label: s.label, skillType: s.skillType}) AS essential`,
    { uris },
  );
  const essentialBy = new Map(rows.map((row) => [row.uri, row.essential]));

  // Everything held going in: the user's own skills, plus — when they gave
  // none — the starting occupation's, so the path still reads sensibly.
  const held = new Set(skills);
  if (held.size === 0) {
    for (const skill of essentialBy.get(candidates[0].steps[0].uri) ?? []) held.add(skill.uri);
  }

  let best: { path: CareerPath; peak: number } | null = null;
  for (const candidate of candidates) {
    const scored = walk(candidate, essentialBy, held, strategy);
    if (
      !best ||
      scored.path.totalLearn < best.path.totalLearn ||
      (scored.path.totalLearn === best.path.totalLearn && scored.peak < best.peak)
    ) {
      best = scored;
    }
  }

  return best!.path;
}

/** Walk one route, charging each skill the first time it is needed. */
function walk(
  candidate: Leg,
  essentialBy: Map<string, SkillRef[]>,
  initiallyHeld: ReadonlySet<string>,
  strategy: CareerPath["strategy"],
): { path: CareerPath; peak: number } {
  const held = new Set(initiallyHeld);
  const hops: PathHop[] = [];
  const acquired = new Set<string>();
  let peak = 0;

  for (let i = 0; i < candidate.steps.length - 1; i += 1) {
    const target = candidate.steps[i + 1];
    const learn = (essentialBy.get(target.uri) ?? [])
      .filter((skill) => !held.has(skill.uri))
      .sort((a, b) => a.label.localeCompare(b.label));

    for (const skill of learn) {
      held.add(skill.uri);
      acquired.add(skill.uri);
    }
    peak = Math.max(peak, learn.length);

    hops.push({
      from: candidate.steps[i].uri,
      to: target.uri,
      jaccard: candidate.jaccards[i] ?? 0,
      learn,
    });
  }

  return {
    path: { steps: candidate.steps, hops, totalLearn: acquired.size, strategy },
    peak,
  };
}

/* -------------------------------------------------------------------------- */
/* Q6 — occupation detail                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything the occupation page shows: the essential/optional split with each
 * skill marked have or missing, and the nearest occupations by derived
 * similarity.
 *
 * One round trip. Both `OPTIONAL MATCH` arms filter in `WHERE`, and both
 * `collect`s are filtered for nulls — an `OPTIONAL MATCH` that finds nothing
 * still contributes one row of nulls, which would otherwise become a phantom
 * skill in the list.
 */
export async function occupationDetail(
  uri: string,
  skills: string[] = [],
): Promise<OccupationDetail | null> {
  if (!uri) return null;

  const rows = await runRead<{
    uri: string;
    label: string;
    description: string;
    altLabels: string[];
    iscoCode?: string;
    iscoGroupLabel?: string;
    essentialCount: number;
    skills: (DetailSkill & { essential: boolean })[];
    neighbours: Neighbour[];
  }>(
    `MATCH (o:Occupation {uri: $uri})
     OPTIONAL MATCH (o)-[r:REQUIRES]->(s:Skill)
     WITH o, [x IN collect({uri: s.uri, label: s.label, skillType: s.skillType,
                            essential: r.essential, have: s.uri IN $skills})
              WHERE x.uri IS NOT NULL] AS skills
     OPTIONAL MATCH (o)-[a:ADJACENT_TO]-(n:Occupation)
     WITH o, skills, n, a
     ORDER BY a.jaccard DESC, n.label
     WITH o, skills,
          [x IN collect({uri: n.uri, label: n.label, jaccard: a.jaccard, shared: a.shared})
           WHERE x.uri IS NOT NULL][0..8] AS neighbours
     RETURN o.uri            AS uri,
            o.label          AS label,
            o.description    AS description,
            o.altLabels      AS altLabels,
            o.iscoCode       AS iscoCode,
            o.iscoGroupLabel AS iscoGroupLabel,
            o.essentialCount AS essentialCount,
            skills, neighbours`,
    { uri, skills },
  );

  const row = rows[0];
  if (!row) return null;

  const byLabel = (a: SkillRef, b: SkillRef) => a.label.localeCompare(b.label);
  const essential = row.skills.filter((s) => s.essential).sort(byLabel);
  const optional = row.skills.filter((s) => !s.essential).sort(byLabel);

  return {
    uri: row.uri,
    label: row.label,
    description: row.description,
    altLabels: row.altLabels ?? [],
    iscoCode: row.iscoCode,
    iscoGroupLabel: row.iscoGroupLabel,
    essential: essential.map(strip),
    optional: optional.map(strip),
    coverage:
      skills.length === 0 || essential.length === 0
        ? null
        : essential.filter((s) => s.have).length / essential.length,
    neighbours: row.neighbours,
  };
}

function strip(skill: DetailSkill & { essential: boolean }): DetailSkill {
  return { uri: skill.uri, label: skill.label, skillType: skill.skillType, have: skill.have };
}

/* -------------------------------------------------------------------------- */
/* Q7 — gap rollup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * **Variable-depth traversal up the skill hierarchy**, so a list of 155 missing
 * skills becomes "78% of your gaps are business administration — you have one
 * problem, not twelve."
 *
 * ### Picking the level to roll up to
 *
 * The obvious rule — group by the code prefix, `S2.6.1` → `S2` — only works on
 * half the data. ESCO's *knowledge* pillar hangs off ISCED-F fields whose
 * groups carry no code at all:
 *
 * ```
 * work skills → business and administration → business, administration and law → knowledge (K)
 * ```
 *
 * So the level is chosen **relative to the root** instead: one below the
 * pillar. That is `S2 information skills` on the skills side and
 * `business, administration and law` on the knowledge side — nameable on both,
 * and stable for skills nested at different depths, which a fixed depth is not.
 *
 * A skill with two parents can reach two themes; it is assigned to exactly one
 * (lowest code, then label) so the shares add to 100% and the headline
 * percentage means what it says.
 */
export async function gapRollup(missing: string[], limit = 6): Promise<GapTheme[]> {
  if (missing.length === 0) return [];

  const rows = await runRead<{
    skill: string;
    skillLabel: string;
    theme: string;
    label: string;
    code: string | null;
    depth: number;
  }>(
    `MATCH (s:Skill) WHERE s.uri IN $missing
     MATCH path = (s)-[:BROADER_THAN*1..8]->(g:SkillGroup)
     RETURN s.uri   AS skill,
            s.label AS skillLabel,
            g.uri   AS theme,
            g.label AS label,
            g.code  AS code,
            min(length(path)) AS depth`,
    { missing },
  );

  const bySkill = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySkill.get(row.skill);
    if (list) list.push(row);
    else bySkill.set(row.skill, [row]);
  }

  const themes = new Map<string, GapTheme>();
  let assigned = 0;

  for (const ancestors of bySkill.values()) {
    const root = Math.max(...ancestors.map((a) => a.depth));
    // One level below the pillar root — or the root itself for a skill that
    // hangs directly off it.
    const wanted = root > 1 ? root - 1 : root;
    const candidates = ancestors
      .filter((a) => a.depth === wanted)
      .sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~") || a.label.localeCompare(b.label));

    const pick = candidates[0];
    if (!pick) continue;
    assigned += 1;

    const theme = themes.get(pick.theme) ?? {
      uri: pick.theme,
      label: pick.label,
      code: pick.code,
      count: 0,
      share: 0,
      examples: [],
    };
    theme.count += 1;
    if (theme.examples.length < 6) theme.examples.push(pick.skillLabel);
    themes.set(pick.theme, theme);
  }

  return [...themes.values()]
    .map((theme) => ({ ...theme, share: assigned === 0 ? 0 : theme.count / assigned }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}
