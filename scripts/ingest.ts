/**
 * Phase 1: ESCO → `data/graph.json`.
 *
 * Walks the ESCO classification and writes one normalised snapshot that
 * `scripts/seed.ts` loads into CognoDB. Four stages:
 *
 *   1. ISCO tree    — 10 major groups down to the 4-digit groups that list
 *                     occupations. This is how we enumerate occupations;
 *                     ESCO's search endpoint cannot return all of them.
 *   2. Occupations  — label, description, ISCO group, and the essential /
 *                     optional skill relations that the whole app runs on.
 *   3. Skill themes — the hierarchy Q7 rolls gaps up through (S4.3.1 → S4.3 →
 *                     S4 → S). Each theme also lists its member skills *with
 *                     labels*, which is what makes this whole stage ~650
 *                     requests instead of ~12,000.
 *   4. Stragglers   — the ~100 skills no theme lists, fetched individually.
 *
 * Run:  npm run ingest                    (~750 requests, about a minute)
 *       npm run ingest -- --limit 25      (a slice, to watch it work)
 *       npm run ingest -- --skill-details (+12k requests: descriptions, reuse levels)
 *
 * Every fetched record is written to `data/cache/*.ndjson` as it arrives, so an
 * interrupted run resumes where it stopped and a re-run costs nothing.
 */
import { existsSync, rmSync, statSync } from "node:fs";
import type {
  BroaderEdge,
  GraphSnapshot,
  OccupationNode,
  RequiresEdge,
  SkillGroupNode,
  SkillNode,
} from "../lib/types";
import {
  alternativeLabels,
  description,
  forEachConcurrent,
  getConcept,
  getOccupation,
  getSkill,
  getTaxonomy,
  JsonLineWriter,
  label,
  lastPathSegment,
  links,
  RecordCache,
  stats,
} from "./esco-api";
import { color, formatBytes, formatDuration, progressReporter } from "./report";

const OCCUPATION_SCHEME = "http://data.europa.eu/esco/concept-scheme/occupations";
const SKILL_SCHEME = "http://data.europa.eu/esco/concept-scheme/skills";
const CACHE_DIR = "data/cache";
const OUTPUT_PATH = "data/graph.json";

/* -------------------------------------------------------------------------- */
/* Cached record shapes                                                        */
/* -------------------------------------------------------------------------- */

/** An ISCO group: an interior node of the occupation tree. */
interface IscoRecord {
  uri: string;
  label: string;
  code?: string;
  narrowerConcepts: string[];
  narrowerOccupations: string[];
}

interface OccupationRecord extends OccupationNode {
  essential: string[];
  optional: string[];
  /** ESCO nests some occupations under others, below the ISCO groups. */
  narrower: string[];
}

interface SkillRecord extends SkillNode {
  broaderSkills: string[];
  broaderGroups: string[];
}

/**
 * A theme in the skill hierarchy, plus the skills that hang off it.
 *
 * `members` is why this stage is cheap: a theme's `narrowerSkill` links carry
 * the skill's URI, label and type, so ~650 theme requests name all ~13,000
 * skills. Fetching each skill instead costs ~12,000 requests and adds only
 * descriptions and reuse levels.
 */
interface SkillGroupRecord extends SkillGroupNode {
  broader: string[];
  narrowerConcepts?: string[];
  members: { uri: string; label: string; skillType?: string }[];
}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

interface Options {
  concurrency: number;
  limit: number;
  refresh: boolean;
  /** Fetch every skill individually for descriptions and reuse levels. */
  skillDetails: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { concurrency: 8, limit: Infinity, refresh: false, skillDetails: false };

  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[i + 1];
    const consume = () => {
      if (inlineValue === undefined) i += 1;
      return value;
    };

    switch (flag) {
      case "--concurrency":
        options.concurrency = Math.max(1, Number(consume()) || 8);
        break;
      case "--limit":
        options.limit = Math.max(1, Number(consume()) || Infinity);
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--skill-details":
        options.skillDetails = true;
        break;
      default:
        if (flag.startsWith("--")) {
          console.error(`Unknown option ${flag}`);
          process.exit(1);
        }
    }
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ESCO's API has a small number of permanently broken resources — `skill/S1.5.3`
 * answers HTTP 500 with "More than one value found for field 'hasSkillType'",
 * every time. One bad concept must not cost a 20-minute crawl, so failures are
 * collected and reported at the end instead of thrown.
 */
const failures: { stage: string; uri: string; message: string }[] = [];

async function attempt<T>(
  stage: string,
  uri: string,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await fetcher();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ stage, uri, message: message.split("\n").pop()?.trim() ?? message });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — the ISCO tree                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Breadth-first over the occupation pillar's interior nodes. Levels are walked
 * one at a time so each level's fetches run concurrently while the ordering
 * stays deterministic.
 */
async function crawlIscoTree(options: Options, cache: RecordCache<IscoRecord>): Promise<string[]> {
  const scheme = await getTaxonomy(OCCUPATION_SCHEME);
  if (!scheme) throw new Error("ESCO returned no occupation concept scheme — is the API up?");

  // Sorted at every level: the API does not order `hasTopConcept`, and a
  // committed snapshot should be reproducible rather than depend on that.
  let frontier = links(scheme, "hasTopConcept")
    .map((link) => link.uri)
    .sort();
  const seen = new Set(frontier);
  const occupationUris = new Set<string>();
  let level = 0;

  while (frontier.length > 0) {
    const report = progressReporter(`ISCO level ${level}`, frontier.length);

    await forEachConcurrent(
      frontier,
      options.concurrency,
      async (uri) => {
        if (!cache.has(uri)) {
          const concept = await attempt("isco", uri, () => getConcept(uri));
          if (!concept) return;
          cache.put({
            uri,
            label: label(concept),
            code: concept.code,
            narrowerConcepts: links(concept, "narrowerConcept").map((l) => l.uri),
            narrowerOccupations: links(concept, "narrowerOccupation").map((l) => l.uri),
          });
        }
      },
      report,
    );

    const next: string[] = [];
    for (const uri of frontier) {
      const record = cache.get(uri);
      if (!record) continue;
      for (const child of record.narrowerConcepts) {
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
      for (const occupation of record.narrowerOccupations) occupationUris.add(occupation);
    }

    frontier = next.sort();
    level += 1;
  }

  return [...occupationUris].sort();
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — occupations                                                       */
/* -------------------------------------------------------------------------- */

async function crawlOccupations(
  seeds: string[],
  options: Options,
  cache: RecordCache<OccupationRecord>,
): Promise<void> {
  // Occupations can nest, so this runs in rounds: fetch what we know about,
  // then fetch whatever those turned out to point at.
  let pending = seeds.slice(0, options.limit === Infinity ? undefined : options.limit);
  const requested = new Set(pending);
  let round = 0;

  while (pending.length > 0) {
    const todo = pending.filter((uri) => !cache.has(uri));
    if (todo.length > 0) {
      const report = progressReporter(round === 0 ? "occupations" : `occupations (round ${round})`, todo.length);
      await forEachConcurrent(
        todo,
        options.concurrency,
        async (uri) => {
          const resource = await attempt("occupation", uri, () => getOccupation(uri));
          if (!resource) return;
          const group = links(resource, "broaderIscoGroup")[0];
          cache.put({
            uri,
            label: label(resource),
            description: description(resource),
            altLabels: alternativeLabels(resource),
            iscoCode: resource.code,
            iscoGroup: group?.uri,
            iscoGroupLabel: group?.title,
            essential: links(resource, "hasEssentialSkill").map((l) => l.uri),
            optional: links(resource, "hasOptionalSkill").map((l) => l.uri),
            narrower: links(resource, "narrowerOccupation").map((l) => l.uri),
          });
        },
        report,
      );
    }

    const next: string[] = [];
    for (const uri of pending) {
      for (const child of cache.get(uri)?.narrower ?? []) {
        if (!requested.has(child)) {
          requested.add(child);
          next.push(child);
        }
      }
    }

    pending = options.limit === Infinity ? next : [];
    round += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — skills                                                            */
/* -------------------------------------------------------------------------- */

async function crawlSkills(
  seeds: string[],
  options: Options,
  cache: RecordCache<SkillRecord>,
): Promise<void> {
  // Same rounds trick: a skill's broader skill may itself be one no occupation
  // requires directly, and Q7 needs the chain intact.
  let pending = seeds;
  const requested = new Set(pending);
  let round = 0;

  while (pending.length > 0) {
    const todo = pending.filter((uri) => !cache.has(uri));
    if (todo.length > 0) {
      const report = progressReporter(round === 0 ? "skills" : `skills (round ${round})`, todo.length);
      await forEachConcurrent(
        todo,
        options.concurrency,
        async (uri) => {
          const resource = await attempt("skill", uri, () => getSkill(uri));
          if (!resource) return;
          cache.put({
            uri,
            label: label(resource),
            description: description(resource),
            altLabels: alternativeLabels(resource),
            skillType: lastPathSegment(links(resource, "hasSkillType")[0]?.uri),
            reuseLevel: lastPathSegment(links(resource, "hasReuseLevel")[0]?.uri),
            broaderSkills: links(resource, "broaderSkill").map((l) => l.uri),
            broaderGroups: links(resource, "broaderHierarchyConcept").map((l) => l.uri),
          });
        },
        report,
      );
    }

    const next: string[] = [];
    for (const uri of pending) {
      for (const parent of cache.get(uri)?.broaderSkills ?? []) {
        if (!requested.has(parent)) {
          requested.add(parent);
          next.push(parent);
        }
      }
    }

    pending = next;
    round += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — skill groups                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds a group the API refuses to serve, from its own code.
 *
 * ESCO group codes are the hierarchy: `S1.5.3` sits under `S1.5` by definition,
 * so the parent URI is derivable, and the parent lists the broken child among
 * its `narrowerConcept` links with a proper label. This is only reached for
 * resources that answered 500 on every retry.
 */
async function recoverSkillGroup(uri: string): Promise<SkillGroupRecord | null> {
  const code = lastPathSegment(uri);
  if (!code?.includes(".")) return null;

  const parentCode = code.slice(0, code.lastIndexOf("."));
  const parentUri = `${uri.slice(0, uri.lastIndexOf("/") + 1)}${parentCode}`;
  const parent = await attempt("skill-group-recovery", parentUri, () => getConcept(parentUri));
  const self = links(parent, "narrowerConcept").find((link) => link.uri === uri);

  return {
    uri,
    label: self?.title ?? code,
    description: "",
    code,
    broader: parent ? [parentUri] : [],
    members: [],
  };
}

/**
 * Walks the skill pillar top-down: 4 top concepts → ~650 themes, each listing
 * its member skills. This is both the hierarchy Q7 rolls gaps up through and
 * the cheapest way to learn every skill's label.
 */
async function crawlSkillTree(options: Options, cache: RecordCache<SkillGroupRecord>): Promise<void> {
  const scheme = await getTaxonomy(SKILL_SCHEME);
  if (!scheme) throw new Error("ESCO returned no skill concept scheme — is the API up?");

  let frontier = links(scheme, "hasTopConcept")
    .map((link) => link.uri)
    .sort();
  const seen = new Set(frontier);
  let level = 0;

  while (frontier.length > 0) {
    const todo = frontier.filter((uri) => !cache.has(uri));
    if (todo.length > 0) {
      const report = progressReporter(`skill themes (level ${level})`, todo.length);
      await forEachConcurrent(
        todo,
        options.concurrency,
        async (uri) => {
          const concept = await attempt("skill-theme", uri, () => getConcept(uri));
          if (!concept) {
            // `skill/S1.5.3` answers 500 permanently. Rebuild what we can; the
            // skills it should have listed are picked up as stragglers below.
            const recovered = await recoverSkillGroup(uri);
            if (recovered) cache.put(recovered);
            return;
          }
          cache.put({
            uri,
            label: label(concept),
            description: description(concept),
            code: concept.code,
            broader: links(concept, "broaderConcept").map((l) => l.uri),
            narrowerConcepts: links(concept, "narrowerConcept").map((l) => l.uri),
            members: links(concept, "narrowerSkill").map((l) => ({
              uri: l.uri,
              label: l.title ?? "",
              skillType: lastPathSegment(l.skillType),
            })),
          });
        },
        report,
      );
    }

    const next: string[] = [];
    for (const uri of frontier) {
      for (const child of cache.get(uri)?.narrowerConcepts ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          next.push(child);
        }
      }
    }

    frontier = next.sort();
    level += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Skills come from two places: every theme's member list (label and type for
 * all ~13,000) and, where it was fetched, the skill's own record (description,
 * reuse level, skill→skill parents). The detailed record wins where present.
 */
function mergeSkills(
  skillRecords: SkillRecord[],
  groupRecords: SkillGroupRecord[],
): { skills: SkillNode[]; membership: BroaderEdge[] } {
  const merged = new Map<string, SkillNode>();
  const membership: BroaderEdge[] = [];

  for (const group of groupRecords) {
    for (const member of group.members) {
      if (!merged.has(member.uri)) {
        merged.set(member.uri, {
          uri: member.uri,
          label: member.label,
          description: "",
          altLabels: [],
          skillType: member.skillType,
        });
      }
      membership.push({ narrow: member.uri, broad: group.uri });
    }
  }

  for (const skill of skillRecords) {
    merged.set(skill.uri, {
      uri: skill.uri,
      label: skill.label,
      description: skill.description,
      altLabels: skill.altLabels,
      skillType: skill.skillType ?? merged.get(skill.uri)?.skillType,
      reuseLevel: skill.reuseLevel,
    });
  }

  return { skills: [...merged.values()], membership };
}

function assemble(
  occupationRecords: OccupationRecord[],
  skillRecords: SkillRecord[],
  groupRecords: SkillGroupRecord[],
  skillDetail: "labels" | "full",
): GraphSnapshot {
  const { skills: mergedSkills, membership } = mergeSkills(skillRecords, groupRecords);

  const occupationUris = new Set(occupationRecords.map((o) => o.uri));
  const skillUris = new Set(mergedSkills.map((s) => s.uri));
  const groupUris = new Set(groupRecords.map((g) => g.uri));

  const requires: RequiresEdge[] = [];
  const occupationBroader: BroaderEdge[] = [];

  for (const occupation of occupationRecords) {
    // Deduplicate: a handful of ESCO occupations list the same skill as both
    // essential and optional. Essential wins — it is the stricter claim, and
    // Q2's subset test would otherwise be wrong.
    const seen = new Set<string>();
    for (const skill of occupation.essential) {
      if (!skillUris.has(skill) || seen.has(skill)) continue;
      seen.add(skill);
      requires.push({ occupation: occupation.uri, skill, essential: true });
    }
    for (const skill of occupation.optional) {
      if (!skillUris.has(skill) || seen.has(skill)) continue;
      seen.add(skill);
      requires.push({ occupation: occupation.uri, skill, essential: false });
    }
    for (const child of occupation.narrower) {
      if (occupationUris.has(child)) occupationBroader.push({ narrow: child, broad: occupation.uri });
    }
  }

  const skillBroader: BroaderEdge[] = membership.filter((edge) => groupUris.has(edge.broad));
  for (const skill of skillRecords) {
    for (const parent of skill.broaderSkills) {
      if (skillUris.has(parent)) skillBroader.push({ narrow: skill.uri, broad: parent });
    }
    for (const parent of skill.broaderGroups) {
      if (groupUris.has(parent)) skillBroader.push({ narrow: skill.uri, broad: parent });
    }
  }
  for (const group of groupRecords) {
    for (const parent of group.broader) {
      if (groupUris.has(parent)) skillBroader.push({ narrow: group.uri, broad: parent });
    }
  }

  const byLabel = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label);
  const byEdge = (a: BroaderEdge, b: BroaderEdge) =>
    a.narrow.localeCompare(b.narrow) || a.broad.localeCompare(b.broad);

  requires.sort((a, b) => a.occupation.localeCompare(b.occupation) || a.skill.localeCompare(b.skill));
  occupationBroader.sort(byEdge);
  // Theme membership arrives from both the theme's member list and the skill's
  // own `broaderHierarchyConcept`; the same edge must not be written twice.
  const dedupedSkillBroader = [
    ...new Map(skillBroader.map((edge) => [`${edge.narrow} ${edge.broad}`, edge])).values(),
  ].sort(byEdge);

  // The relations above are edges now; the node lists carry only node fields.
  const occupations: OccupationNode[] = occupationRecords
    .map((o) => ({
      uri: o.uri,
      label: o.label,
      description: o.description,
      altLabels: o.altLabels,
      iscoCode: o.iscoCode,
      iscoGroup: o.iscoGroup,
      iscoGroupLabel: o.iscoGroupLabel,
    }))
    .sort(byLabel);
  const skills: SkillNode[] = mergedSkills.sort(byLabel);
  const skillGroups: SkillGroupNode[] = groupRecords
    .map((g) => ({ uri: g.uri, label: g.label, description: g.description, code: g.code }))
    .sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""));

  return {
    meta: {
      source: "ESCO v1.2 via the ESCO REST API (https://ec.europa.eu/esco/api)",
      license:
        "© European Union, 2026. ESCO is reused under the European Commission's ESCO reuse terms; " +
        "see https://esco.ec.europa.eu/en/use-esco/download",
      language: "en",
      fetchedAt: new Date().toISOString(),
      skillDetail,
      counts: {
        occupations: occupations.length,
        skills: skills.length,
        skillGroups: skillGroups.length,
        requires: requires.length,
        essentialRequires: requires.filter((r) => r.essential).length,
        occupationBroader: occupationBroader.length,
        skillBroader: dedupedSkillBroader.length,
      },
    },
    occupations,
    skills,
    skillGroups,
    requires,
    occupationBroader,
    skillBroader: dedupedSkillBroader,
  };
}

function write(snapshot: GraphSnapshot): void {
  const out = new JsonLineWriter(OUTPUT_PATH);
  out.write("{\n");
  out.write(`"meta": ${JSON.stringify(snapshot.meta, null, 2)},\n`);
  out.array("occupations", snapshot.occupations);
  out.array("skills", snapshot.skills);
  out.array("skillGroups", snapshot.skillGroups);
  out.array("requires", snapshot.requires);
  out.array("occupationBroader", snapshot.occupationBroader);
  out.array("skillBroader", snapshot.skillBroader, true);
  out.write("}\n");
  out.close();
}

/* -------------------------------------------------------------------------- */
/* Sanity report                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The checkpoint. Phase 1 is only done if these numbers look like a labour
 * market — the most-required skills should read like things a person can
 * learn, and almost every occupation should have essential skills, or Q2 and
 * Q4 have nothing to work with.
 */
function report(snapshot: GraphSnapshot): void {
  const { counts } = snapshot.meta;
  const skillLabels = new Map(snapshot.skills.map((s) => [s.uri, s.label]));

  const essentialByOccupation = new Map<string, number>();
  const demand = new Map<string, number>();
  for (const edge of snapshot.requires) {
    if (!edge.essential) continue;
    essentialByOccupation.set(edge.occupation, (essentialByOccupation.get(edge.occupation) ?? 0) + 1);
    demand.set(edge.skill, (demand.get(edge.skill) ?? 0) + 1);
  }

  const withoutEssential = snapshot.occupations.filter((o) => !essentialByOccupation.has(o.uri));
  const averageEssential = counts.essentialRequires / Math.max(counts.occupations, 1);
  const orphanSkills = snapshot.skills.filter((s) => !demand.has(s.uri)).length;

  const parents = new Set(snapshot.skillBroader.map((e) => e.narrow));
  const rootlessSkills = snapshot.skills.filter((s) => !parents.has(s.uri)).length;

  const distribution = (values: (string | undefined)[]) => {
    const tally = new Map<string, number>();
    for (const value of values) tally.set(value ?? "—", (tally.get(value ?? "—") ?? 0) + 1);
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => `${key} ${n}`)
      .join(" · ");
  };

  console.log(color.bold("\nSnapshot"));
  console.log(`  occupations        ${counts.occupations}`);
  console.log(`  skills             ${counts.skills}`);
  console.log(`  skill groups       ${counts.skillGroups}`);
  console.log(
    `  REQUIRES           ${counts.requires}  ${color.dim(`(${counts.essentialRequires} essential, ${counts.requires - counts.essentialRequires} optional)`)}`,
  );
  console.log(`  BROADER_THAN       ${counts.occupationBroader} occupation · ${counts.skillBroader} skill`);
  console.log(`  file               ${OUTPUT_PATH} ${formatBytes(statSync(OUTPUT_PATH).size)}`);

  console.log(color.bold("\nShape"));
  console.log(`  essential skills per occupation   avg ${averageEssential.toFixed(1)}`);
  console.log(`  occupations with none             ${withoutEssential.length}`);
  console.log(`  skills no occupation requires     ${orphanSkills} ${color.dim("(hierarchy-only ancestors)")}`);
  console.log(`  skills with no broader concept    ${rootlessSkills}`);
  console.log(`  skill type                        ${distribution(snapshot.skills.map((s) => s.skillType))}`);
  const described = snapshot.skills.filter((s) => s.description).length;
  console.log(
    `  skills with description           ${described}/${counts.skills} ${color.dim(
      snapshot.meta.skillDetail === "full" ? "" : "(run with --skill-details for all of them)",
    )}`,
  );
  console.log(`  reuse level                       ${distribution(snapshot.skills.map((s) => s.reuseLevel))}`);

  console.log(color.bold("\nMost-required skills") + color.dim(" — the raw signal behind Q4"));
  for (const [uri, n] of [...demand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(4)}  ${skillLabels.get(uri) ?? uri}`);
  }

  if (failures.length > 0) {
    console.log(color.bold("\nResources ESCO would not serve") + color.dim(` — ${failures.length}`));
    for (const failure of failures.slice(0, 8)) {
      console.log(color.dim(`  ${failure.stage}  ${failure.uri.split("/esco/")[1]}  ${failure.message}`));
    }
    if (failures.length > 8) console.log(color.dim(`  … and ${failures.length - 8} more`));
  }

  const problems: string[] = [];
  if (failures.length > 20) problems.push(`${failures.length} resources failed to fetch — re-run to retry them`);
  if (counts.occupations < 2500) problems.push(`only ${counts.occupations} occupations — expected ~3,000`);
  if (counts.essentialRequires < 30_000) problems.push(`only ${counts.essentialRequires} essential relations`);
  if (withoutEssential.length > counts.occupations * 0.05) {
    problems.push(`${withoutEssential.length} occupations have no essential skills`);
  }
  if (counts.skillBroader === 0) problems.push("no skill hierarchy — Q7 has nothing to roll up");

  if (problems.length > 0) {
    console.log(color.yellow("\n! Worth a look before Phase 2:"));
    for (const problem of problems) console.log(color.yellow(`    · ${problem}`));
  } else {
    console.log(color.green("\n✓ Snapshot looks like a labour market. Phase 2 (schema + seed) is clear."));
  }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  console.log(color.bold("\nESCO ingest"));
  console.log(
    color.dim(
      `  concurrency ${options.concurrency}${options.limit === Infinity ? "" : ` · limit ${options.limit}`}` +
        ` · skill detail: ${options.skillDetails ? "full (~12k extra requests)" : "labels from themes"}`,
    ),
  );

  if (options.refresh && existsSync(CACHE_DIR)) {
    rmSync(CACHE_DIR, { recursive: true, force: true });
    console.log(color.dim("  cache cleared"));
  }

  const isco = new RecordCache<IscoRecord>(`${CACHE_DIR}/isco.ndjson`);
  const occupations = new RecordCache<OccupationRecord>(`${CACHE_DIR}/occupations.ndjson`);
  const skills = new RecordCache<SkillRecord>(`${CACHE_DIR}/skills.ndjson`);
  const groups = new RecordCache<SkillGroupRecord>(`${CACHE_DIR}/skill-themes.ndjson`);

  const cached = isco.size + occupations.size + skills.size + groups.size;
  if (cached > 0) console.log(color.dim(`  resuming with ${cached} cached records`));

  const occupationUris = await crawlIscoTree(options, isco);
  console.log(color.dim(`  ${isco.size} ISCO groups → ${occupationUris.length} occupations`));

  await crawlOccupations(occupationUris, options, occupations);

  const occupationRecords = occupations.values();
  const referenced = new Set(
    occupationRecords.flatMap((occupation) => [...occupation.essential, ...occupation.optional]),
  );

  await crawlSkillTree(options, groups);
  const named = new Set(groups.values().flatMap((group) => group.members.map((m) => m.uri)));
  console.log(color.dim(`  ${groups.size} skill themes name ${named.size} skills`));

  // Skills no theme lists — ESCO nests some skills under other skills, and a
  // theme that answers 500 takes its members with it. Fetch those directly.
  const stragglers = [...referenced].filter((uri) => !named.has(uri)).sort();
  const skillSeeds = options.skillDetails ? [...referenced].sort() : stragglers;
  if (skillSeeds.length > 0) {
    if (!options.skillDetails) {
      console.log(color.dim(`  ${stragglers.length} skills no theme lists — fetching those directly`));
    }
    await crawlSkills(skillSeeds, options, skills);
  }

  const skillRecords = skills.values();

  console.log(
    color.dim(
      `\n  ${stats.requests} requests · ${stats.retries} retries · ${stats.rateLimited} rate-limited · ${formatBytes(stats.bytes)} · ${formatDuration((Date.now() - started) / 1000)}`,
    ),
  );

  const snapshot = assemble(
    occupationRecords,
    skillRecords,
    groups.values(),
    options.skillDetails ? "full" : "labels",
  );
  write(snapshot);
  report(snapshot);
}

main().catch((error) => {
  console.error(color.red(`\n✗ Ingest failed: ${(error as Error).message}`));
  console.error(color.dim("  Cached records are kept — re-run to resume from where it stopped."));
  process.exitCode = 1;
});
