/**
 * Phase 3: run every query in `lib/queries.ts` against the live instance.
 *
 *   npm run queries
 *
 * This is the Phase 3 checkpoint from PLAN.md §7 — "Q4 returns sensible bridge
 * skills from a real skill set, in the terminal" — and it stays in the
 * repository afterwards as the thing to run when a query is changed. It is not
 * a unit test suite: there is no fixture and no mock, it asks the real database
 * real questions and checks the answers are shaped like answers.
 *
 * Every step is timed, because latency *is* the design constraint here. The c0
 * instance charges ~0.85s of round trip before any work happens, and enforces a
 * 5-second BFS budget; a query that regresses past a couple of seconds needs to
 * be seen, not discovered in the UI.
 *
 * The scenario is Priya from PLAN.md §1 — a retail department manager, whose
 * skills are read from the graph rather than hard-coded, so this keeps working
 * if the snapshot is re-ingested.
 */
import "dotenv/config";
import {
  closeDriver,
  DbAuthError,
  DbUnreachableError,
  runRead,
  verifyConnection,
} from "../lib/db";
import { EnvError, getEnv } from "../lib/env";
import {
  bridgeSkills,
  careerPath,
  closestRoles,
  gapRollup,
  occupationDetail,
  occupationPrefill,
  searchOccupations,
  searchSkills,
  withinReach,
} from "../lib/queries";
import { color } from "./report";

const HOME = "retail department manager";
const TARGET = "supply chain manager";
const BRIDGE_FROM = "baker"; // far enough from software developer to force the fallback
const FAR_TARGET = "software developer";
const UNREACHABLE = "general practitioner"; // one of the five with no ADJACENT_TO edge

let passed = 0;
let failed = 0;

/**
 * Run one labelled step, time it, and assert something true of the result.
 * `expect` returns an empty string when happy, or the reason it is not.
 */
async function check<T>(
  id: string,
  what: string,
  run: () => Promise<T>,
  expect: (value: T) => string,
  show?: (value: T) => void,
): Promise<T> {
  const started = Date.now();
  let value: T;
  try {
    value = await run();
  } catch (error) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${id.padEnd(4)}${what.padEnd(44)}${color.red("threw")}`);
    console.log(`      ${color.red((error as Error).message.split("\n")[0])}`);
    throw error;
  }

  const elapsed = Date.now() - started;
  const problem = expect(value);
  const slow = elapsed > 3000;

  if (problem) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${id.padEnd(4)}${what.padEnd(44)}${String(elapsed).padStart(6)}ms`);
    console.log(`      ${color.red(problem)}`);
  } else {
    passed += 1;
    const time = `${String(elapsed).padStart(6)}ms`;
    console.log(
      `  ${color.green("✓")} ${id.padEnd(4)}${what.padEnd(44)}${slow ? color.yellow(time) : color.dim(time)}`,
    );
  }

  show?.(value);
  return value;
}

const percent = (n: number) => `${Math.round(n * 100)}%`;
const bullet = (line: string) => console.log(color.dim(`      ${line}`));

async function uriOf(label: string): Promise<string> {
  const [row] = await runRead<{ uri: string }>(
    "MATCH (o:Occupation {label: $label}) RETURN o.uri AS uri",
    { label },
  );
  if (!row) throw new Error(`No occupation labelled "${label}" — has the graph been seeded?`);
  return row.uri;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  try {
    getEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(color.red(`\n✗ ${error.message}\n`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    await verifyConnection();
  } catch (error) {
    console.error(
      color.red(
        `\n✗ ${
          error instanceof DbAuthError
            ? "Authentication failed. Check COGNODB_USER / COGNODB_PASSWORD."
            : error instanceof DbUnreachableError
              ? "Could not reach the instance. Check COGNODB_URI and that it is running."
              : (error as Error).message
        }\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const homeUri = await uriOf(HOME);

  /* ---- Q0 / Q1: the two doors ------------------------------------------- */

  console.log(color.bold("\nQ0 · Q1 — input"));

  await check(
    "Q0",
    'skill typeahead "man"',
    () => searchSkills("man"),
    (rows) => {
      if (rows.length === 0) return "no suggestions";
      const ordered = rows.every((row, i) => i === 0 || rows[i - 1].demand >= row.demand);
      return ordered ? "" : "not ranked by demand";
    },
    (rows) => rows.slice(0, 3).forEach((r) => bullet(`${r.label} — required by ${r.demand} occupations`)),
  );

  await check(
    "Q0",
    "one character returns nothing (no scan)",
    () => searchSkills("m"),
    (rows) => (rows.length === 0 ? "" : `expected 0 rows, got ${rows.length}`),
  );

  await check(
    "Q1",
    'occupation typeahead "shop"',
    () => searchOccupations("shop"),
    (rows) => (rows.length > 0 ? "" : "no suggestions"),
    (rows) =>
      rows.slice(0, 3).forEach((r) =>
        bullet(`${r.label}${r.matchedAlt ? color.dim(` (matched "${r.matchedAlt}")`) : ""} — ${r.essentialCount} essential skills`),
      ),
  );

  const prefill = await check(
    "Q1",
    `prefill from "${HOME}"`,
    () => occupationPrefill(homeUri),
    (result) => {
      if (!result) return "returned null for a known occupation";
      if (result.essentialSkills.length === 0) return "no essential skills";
      if (result.essentialSkills.length !== result.occupation.essentialCount) {
        return `${result.essentialSkills.length} skills vs essentialCount ${result.occupation.essentialCount} — the denormalised count is wrong`;
      }
      return "";
    },
    (result) => bullet(`${result?.essentialSkills.length} editable skill chips`),
  );

  await check(
    "Q1",
    "unknown occupation → null (so the API can 404)",
    () => occupationPrefill("http://data.europa.eu/esco/occupation/does-not-exist"),
    (result) => (result === null ? "" : "expected null"),
  );

  const skills = prefill?.essentialSkills.map((s) => s.uri) ?? [];

  /* ---- Q2 / Q3: the tiers ----------------------------------------------- */

  console.log(color.bold(`\nQ2 · Q3 — results for a ${HOME} (${skills.length} skills)`));

  const closest = await check(
    "Q2",
    "closest roles by coverage",
    () => closestRoles(skills, 12, [homeUri]),
    (rows) => {
      if (rows.length === 0) return "no matches for a 17-skill input";
      const ordered = rows.every((row, i) => i === 0 || rows[i - 1].coverage >= row.coverage);
      if (!ordered) return "not ordered by coverage";
      const bad = rows.find((row) => row.missing.length !== row.gap);
      return bad ? `${bad.label}: gap ${bad.gap} but ${bad.missing.length} missing skills listed` : "";
    },
    (rows) =>
      rows.slice(0, 4).forEach((r) =>
        bullet(`${percent(r.coverage).padStart(4)}  ${r.label} — has ${r.have}/${r.total}, missing ${r.missing[0]?.label}…`),
      ),
  );

  await check(
    "Q3",
    "within reach (coverage ≥ 50%)",
    () => withinReach(skills, 12, [homeUri]),
    (rows) => (rows.every((row) => row.coverage >= 0.5) ? "" : "a row slipped below the floor"),
    (rows) =>
      rows.length === 0
        ? bullet("none — real answer, not a bug: the nearest role is at 45%")
        : rows.slice(0, 4).forEach((r) => bullet(`${percent(r.coverage)}  ${r.label}`)),
  );

  /* ---- Q4: the hero ------------------------------------------------------ */

  console.log(color.bold("\nQ4 — bridge skills"));

  const bridges = await check(
    "Q4",
    "which one skill advances the most roles",
    () => bridgeSkills(skills, { pool: 100, exclude: [homeUri] }),
    (result) => {
      if (result.skills.length === 0) return "no bridge skills — the hero card would be empty";
      if (result.pool === 0) return "empty pool";
      const ordered = result.skills.every((s, i) => i === 0 || result.skills[i - 1].advances >= s.advances);
      if (!ordered) return "not ordered by reach";
      const overflow = result.skills.find((s) => s.advances > result.pool);
      if (overflow) return `${overflow.label} advances ${overflow.advances} of a ${result.pool} pool`;
      const known = new Set(skills);
      const owned = result.skills.find((s) => known.has(s.uri));
      return owned ? `suggested "${owned.label}", which the user already has` : "";
    },
    (result) => {
      result.skills.slice(0, 4).forEach((s) =>
        bullet(`${s.label} → advances ${s.advances} of your ${result.pool} nearest roles — ${s.examples.slice(0, 3).join(", ")}`),
      );
      const completes = result.skills.reduce((sum, s) => sum + s.completes, 0);
      bullet(
        completes === 0
          ? color.yellow("completes: 0 for every skill — nothing on ESCO is one skill away (PLAN.md §11)")
          : `completes outright: ${completes}`,
      );
    },
  );

  /* ---- Q5: paths --------------------------------------------------------- */

  console.log(color.bold("\nQ5 — career path"));

  const showPath = (path: Awaited<ReturnType<typeof careerPath>>) => {
    if (!path) return;
    bullet(`${path.strategy}: ${path.steps.map((s) => s.label).join(" → ")}`);
    path.hops.forEach((hop, i) =>
      bullet(
        `  hop ${i + 1}: learn ${hop.learn.length} skill${hop.learn.length === 1 ? "" : "s"} ` +
          `(similarity ${hop.jaccard.toFixed(2)})${hop.learn[0] ? ` — ${hop.learn[0].label}…` : ""}`,
      ),
    );
    bullet(`  ${path.totalLearn} distinct skills across the whole route`);
  };

  const validPath =
    (label: string, strategy?: "direct" | "bidirectional") =>
    (path: Awaited<ReturnType<typeof careerPath>>) => {
      if (!path) return `no path to ${label}`;
      if (path.steps.length < 2) return "path has no hops";
      if (path.hops.length !== path.steps.length - 1) return "hop count does not match step count";
      if (strategy && path.strategy !== strategy) {
        return `expected the ${strategy} strategy, got ${path.strategy} — this case no longer covers it`;
      }
      const unique = new Set(path.steps.map((step) => step.uri));
      if (unique.size !== path.steps.length) return "the route visits an occupation twice";
      // Cumulative accounting: a skill learned once must not be charged again.
      const seen = new Set<string>();
      for (const hop of path.hops) {
        for (const skill of hop.learn) {
          if (seen.has(skill.uri)) return `"${skill.label}" charged on two hops`;
          seen.add(skill.uri);
        }
      }
      return seen.size === path.totalLearn ? "" : "totalLearn disagrees with the hops";
    };

  const toTarget = await check(
    "Q5",
    `${HOME} → ${TARGET}`,
    async () => careerPath(homeUri, await uriOf(TARGET), { skills }),
    validPath(TARGET, "direct"),
    showPath,
  );

  // The plan claimed stepping stones are cheaper than the leap. Measure it
  // rather than assume it — see PLAN.md §12.
  const [direct] = await runRead<{ gap: number }>(
    `MATCH (b:Occupation {label: $target})-[r:REQUIRES]->(m:Skill)
     WHERE r.essential = true AND NOT m.uri IN $skills
     RETURN count(m) AS gap`,
    { target: TARGET, skills },
  );
  bullet(
    `vs. leaping straight there: ${direct.gap} skills at once, ` +
      `against ${toTarget?.totalLearn} spread over ${toTarget?.hops.length} holdable jobs`,
  );

  await check(
    "Q5",
    `${BRIDGE_FROM} → ${FAR_TARGET} (bidirectional fallback)`,
    async () => careerPath(await uriOf(BRIDGE_FROM), await uriOf(FAR_TARGET)),
    validPath(FAR_TARGET, "bidirectional"),
    showPath,
  );

  await check(
    "Q5",
    `${UNREACHABLE} has no neighbours → null`,
    async () => careerPath(homeUri, await uriOf(UNREACHABLE), { skills }),
    (path) => (path === null ? "" : "expected null for an isolated occupation"),
    () => bullet("the UI shows the raw skill gap instead of an empty chain"),
  );

  /* ---- Q6: detail -------------------------------------------------------- */

  console.log(color.bold("\nQ6 — occupation detail"));

  const first = closest?.[0];
  await check(
    "Q6",
    `detail for "${first?.label ?? "?"}", marked against my skills`,
    () => occupationDetail(first!.uri, skills),
    (detail) => {
      if (!detail) return "returned null";
      if (detail.essential.length === 0) return "no essential skills";
      const have = detail.essential.filter((s) => s.have).length;
      if (have !== first!.have) return `marked ${have} skills as held, Q2 counted ${first!.have}`;
      if (detail.neighbours.length === 0) return "no neighbours — ADJACENT_TO missing?";
      const ordered = detail.neighbours.every((n, i) => i === 0 || detail.neighbours[i - 1].jaccard >= n.jaccard);
      return ordered ? "" : "neighbours not ordered by similarity";
    },
    (detail) => {
      if (!detail) return;
      bullet(
        `${detail.essential.length} essential (${detail.essential.filter((s) => s.have).length} held, ` +
          `${percent(detail.coverage ?? 0)} coverage) · ${detail.optional.length} optional`,
      );
      bullet(`nearest: ${detail.neighbours.slice(0, 3).map((n) => `${n.label} (${n.jaccard.toFixed(2)})`).join(", ")}`);
    },
  );

  await check(
    "Q6",
    "unknown occupation → null",
    () => occupationDetail("http://data.europa.eu/esco/occupation/does-not-exist", skills),
    (detail) => (detail === null ? "" : "expected null"),
  );

  await check(
    "Q6",
    "no skills supplied → coverage null, not 0%",
    () => occupationDetail(first!.uri),
    (detail) => (detail?.coverage === null ? "" : `expected null coverage, got ${detail?.coverage}`),
  );

  /* ---- Q7: rollup -------------------------------------------------------- */

  console.log(color.bold("\nQ7 — gap rollup"));

  const missing = [...new Set((closest ?? []).flatMap((role) => role.missing.map((s) => s.uri)))];

  await check(
    "Q7",
    `${missing.length} missing skills → themes`,
    () => gapRollup(missing),
    (themes) => {
      if (themes.length === 0) return "nothing rolled up — the hierarchy walk found no ancestors";
      const total = themes.reduce((sum, t) => sum + t.share, 0);
      if (total > 1.0001) return `shares sum to ${total.toFixed(2)} — a skill was counted twice`;
      const ordered = themes.every((t, i) => i === 0 || themes[i - 1].count >= t.count);
      return ordered ? "" : "not ordered by size";
    },
    (themes) =>
      themes.slice(0, 5).forEach((t) =>
        bullet(`${percent(t.share).padStart(4)}  ${t.label}${t.code ? color.dim(` (${t.code})`) : ""} — ${t.count} skills`),
      ),
  );

  await check(
    "Q7",
    "no gaps → empty, without a round trip",
    () => gapRollup([]),
    (themes) => (themes.length === 0 ? "" : "expected no themes"),
  );

  /* ---- Summary ----------------------------------------------------------- */

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    failed === 0
      ? color.green(`\n✓ ${passed} checks passed in ${seconds}s. Next: Phase 4, the API routes.\n`)
      : color.red(`\n✗ ${failed} of ${passed + failed} checks failed (${seconds}s).\n`),
  );
  if (failed > 0) process.exitCode = 1;

  // Guard against a silently useless run: the hero query having nothing to say
  // is a product failure even though every individual check passed.
  if (failed === 0 && (bridges?.skills.length ?? 0) === 0) {
    console.log(color.yellow("! Q4 returned nothing. The app has no story — investigate before Phase 4.\n"));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(color.red(`\n✗ Query check failed: ${(error as Error).message}\n`));
    process.exitCode = 1;
  })
  .finally(closeDriver);
