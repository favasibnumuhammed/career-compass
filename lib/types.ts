/**
 * Shared shapes.
 *
 * Two groups: the ingest snapshot — the contract between `scripts/ingest.ts`
 * (writes `data/graph.json`) and `scripts/seed.ts` (loads it into CognoDB) —
 * and, at the bottom, what `lib/queries.ts` hands back to the API layer.
 */

/** A job. `iscoGroup*` places it in the ISCO-08 occupational classification. */
export interface OccupationNode {
  uri: string;
  label: string;
  description: string;
  /** Synonyms ESCO lists for the same job — "shop manager" for "retail manager". */
  altLabels: string[];
  /** ESCO's occupation code, e.g. `1420.2`. */
  iscoCode?: string;
  iscoGroup?: string;
  iscoGroupLabel?: string;
}

/**
 * A skill, competence or piece of knowledge.
 *
 * `reuseLevel` is the one worth knowing: `transversal` skills apply across the
 * whole labour market, `occupation-specific` ones apply to a single job. It is
 * what lets the UI explain *why* a bridge skill has leverage.
 */
export interface SkillNode {
  uri: string;
  label: string;
  description: string;
  altLabels: string[];
  /** `skill` or `knowledge`. */
  skillType?: string;
  /** `transversal` · `cross-sector` · `sector-specific` · `occupation-specific`. */
  reuseLevel?: string;
}

/**
 * A theme in the ESCO skill hierarchy — "managing budgets or finances" (S4.3.1)
 * above "manage budgets". Q7 rolls a user's gaps up to these to say "78% of
 * what you're missing is business administration" instead of listing twelve
 * unrelated skills.
 */
export interface SkillGroupNode {
  uri: string;
  label: string;
  description: string;
  /** Hierarchy code, e.g. `S4.3.1`. Its depth is the level in the tree. */
  code?: string;
}

/** Occupation requires skill. `essential` is ESCO's own flag, not a threshold we chose. */
export interface RequiresEdge {
  occupation: string;
  skill: string;
  essential: boolean;
}

/** `narrow` is a specialisation of `broad`. Used for both pillars. */
export interface BroaderEdge {
  narrow: string;
  broad: string;
}

/**
 * Two occupations with similar essential-skill sets. **Derived at load time,
 * not present in ESCO** — see `scripts/adjacency.ts`.
 *
 * Stored once per unordered pair (`from` < `to`) and traversed undirected:
 * "nearest 15" is not a symmetric relation, so writing it as a directed edge
 * would make paths depend on which end you started from.
 */
export interface AdjacentEdge {
  from: string;
  to: string;
  /** Count of essential skills both occupations require. */
  shared: number;
  /** Jaccard similarity of the two essential-skill sets, rounded to 3dp. */
  jaccard: number;
}

export interface GraphSnapshotMeta {
  source: string;
  license: string;
  language: string;
  /** ISO timestamp of the crawl that produced this file. */
  fetchedAt: string;
  /**
   * How much was fetched per skill. `labels` reads skills off their theme's
   * member list — one request per theme, ~650 in total — which is enough for
   * every query but leaves `description` and `reuseLevel` empty. `full` adds a
   * request per skill (~12,000) to fill those in.
   */
  skillDetail: "labels" | "full";
  counts: {
    occupations: number;
    skills: number;
    skillGroups: number;
    requires: number;
    essentialRequires: number;
    occupationBroader: number;
    skillBroader: number;
  };
}

/**
 * The normalised ESCO extract. Committed to the repository so that seeding a
 * fresh database needs no crawl — `npm run seed` reads this file and nothing
 * else.
 */
export interface GraphSnapshot {
  meta: GraphSnapshotMeta;
  occupations: OccupationNode[];
  skills: SkillNode[];
  skillGroups: SkillGroupNode[];
  requires: RequiresEdge[];
  /** Occupation pillar: `narrow` is a narrower occupation of `broad`. */
  occupationBroader: BroaderEdge[];
  /** Skill pillar: skill→skill, skill→group and group→group edges together. */
  skillBroader: BroaderEdge[];
}

/* ========================================================================== */
/* Query results — Phase 3                                                    */
/* ========================================================================== */

/** Q0 — a skill offered by the typeahead. */
export interface SkillSuggestion {
  uri: string;
  label: string;
  skillType?: string;
  reuseLevel?: string;
  /** Occupations that require this skill as essential. The typeahead's ranking. */
  demand: number;
}

/** Q1 — an occupation offered by the "start from a job you've done" typeahead. */
export interface OccupationSuggestion {
  uri: string;
  label: string;
  iscoGroupLabel?: string;
  essentialCount: number;
  optionalCount: number;
  /** Set when the query matched a synonym rather than the preferred label. */
  matchedAlt?: string;
}

/** Q1 — the chosen occupation with the skills that prefill the editor. */
export interface OccupationPrefill {
  occupation: OccupationSuggestion;
  essentialSkills: SkillRef[];
}

export interface SkillRef {
  uri: string;
  label: string;
  skillType?: string;
}

/**
 * Q2 / Q3 — one occupation scored against the user's skills.
 *
 * `coverage` is the fraction of this occupation's *essential* skills the user
 * already has. It is the number the tiers are cut on, and the honest version of
 * the plan's "ready now / one skill away": on real ESCO data nothing is ever
 * one skill away (see PLAN.md §11), so we rank by coverage instead of
 * pretending a subset match exists.
 */
export interface RoleMatch {
  uri: string;
  label: string;
  iscoGroupLabel?: string;
  /** Essential skills of this occupation that the user already has. */
  have: number;
  /** Essential skills this occupation requires in total. */
  total: number;
  /** `have / total`, 0–1. */
  coverage: number;
  /** `total - have`. */
  gap: number;
  /** The missing essential skills themselves, capped by the query. */
  missing: SkillRef[];
}

/**
 * Q4 — the hero result. One skill, and the roles that learning it moves the
 * user closer to.
 */
export interface BridgeSkill {
  uri: string;
  label: string;
  skillType?: string;
  reuseLevel?: string;
  /** How many of the candidate roles list this skill among their gaps. */
  advances: number;
  /** Of those, how many it would *complete* — the plan's original Q4. Usually 0. */
  completes: number;
  /** Mean coverage of the roles it advances: leverage on near roles beats far ones. */
  meanCoverage: number;
  /** Named roles, closest first. */
  examples: string[];
}

/** Q4's denominator, reported alongside the results so the UI can name it. */
export interface BridgeSkillResult {
  skills: BridgeSkill[];
  /** How many candidate roles were considered — "56 of your 100 nearest roles". */
  pool: number;
}

/** Q5 — one step of a career path. */
export interface PathStep {
  uri: string;
  label: string;
  essentialCount: number;
}

/** Q5 — the move between two steps: how alike they are, and what it costs. */
export interface PathHop {
  from: string;
  to: string;
  /** Similarity of the two occupations' essential-skill sets, 0–1. */
  jaccard: number;
  /** Skills to acquire for this hop, given everything held or learned so far. */
  learn: SkillRef[];
}

export interface CareerPath {
  steps: PathStep[];
  hops: PathHop[];
  /** Distinct skills acquired across the whole route. */
  totalLearn: number;
  /**
   * How the path was found. `direct` is a single server-side `shortestPath`;
   * `bidirectional` is the meet-in-the-middle fallback. See `lib/queries.ts`.
   */
  strategy: "direct" | "bidirectional";
}

/** Q6 — an occupation page. */
export interface OccupationDetail {
  uri: string;
  label: string;
  description: string;
  altLabels: string[];
  iscoCode?: string;
  iscoGroupLabel?: string;
  essential: DetailSkill[];
  optional: DetailSkill[];
  /** Coverage over essential skills, 0–1. `null` when the user gave no skills. */
  coverage: number | null;
  neighbours: Neighbour[];
}

export interface DetailSkill extends SkillRef {
  /** Whether the user already has it. */
  have: boolean;
}

export interface Neighbour {
  uri: string;
  label: string;
  jaccard: number;
  shared: number;
}

/**
 * Q7 — the user's gaps grouped by ESCO theme: "78% of what you're missing is
 * business administration" instead of a list of twelve unrelated skills.
 */
export interface GapTheme {
  uri: string;
  label: string;
  /** ESCO hierarchy code (`S2`). Null across the knowledge pillar, which uses ISCED. */
  code: string | null;
  /** Missing skills that roll up to this theme. */
  count: number;
  /** `count` over all rolled-up skills, 0–1. */
  share: number;
  examples: string[];
}

/* ========================================================================== */
/* API payloads — Phase 4                                                     */
/* ========================================================================== */

/**
 * Everything the results page needs, from one `POST /api/analyze`.
 *
 * One payload rather than four requests: the tiers, the hero card and the gap
 * rollup are one thought, and four round trips against a burstable half-core
 * would render the page in stages for no benefit.
 */
export interface AnalysisResult {
  /** Tier 1 — closest roles by coverage. */
  closest: RoleMatch[];
  /** Tier 2 — the subset at coverage ≥ 50%. Often empty, which is a real answer. */
  withinReach: RoleMatch[];
  /** Tier 3 — the hero. */
  bridges: BridgeSkillResult;
  /** Gaps grouped by ESCO theme. */
  themes: GapTheme[];
  meta: {
    /** Skills accepted after normalisation — malformed ones are dropped. */
    skills: number;
    /** Distinct missing skills the rollup was computed over. */
    gaps: number;
  };
}

/** `POST /api/path`. `path` is null when no route exists — not an error. */
export interface PathResult {
  from: { uri: string; label: string };
  to: { uri: string; label: string };
  path: CareerPath | null;
  /**
   * Why there is no path, when there isn't one. `unreachable` means the two
   * occupations are more than six similarity hops apart, or one of them has no
   * neighbours at all.
   */
  reason?: "unreachable";
}
