/**
 * Phase 2: load `data/graph.json` into CognoDB.
 *
 * Run:  npm run schema && npm run seed
 *       npm run seed -- --wipe          (clear the graph first)
 *       npm run seed -- --batch 250     (smaller batches if the instance strains)
 *
 * Everything goes in as batched `UNWIND` — one round trip per 500 rows, not one
 * per row. 130k individual `MERGE` statements against a 0.5 vCPU instance is
 * the difference between ninety seconds and an afternoon.
 *
 * `ADJACENT_TO` is derived here rather than read from the snapshot, so
 * `data/graph.json` stays a faithful extract of ESCO and the one edge we
 * invented stays visibly ours. See `scripts/adjacency.ts`.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import type { GraphSnapshot } from "../lib/types";
import { closeDriver, DbAuthError, DbUnreachableError, runRead, runWrite, verifyConnection } from "../lib/db";
import { EnvError, getEnv } from "../lib/env";
import { deriveAdjacency } from "./adjacency";
import { color, formatDuration, progressReporter } from "./report";

const SNAPSHOT_PATH = "data/graph.json";

interface Options {
  batch: number;
  wipe: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { batch: 500, wipe: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=");
    if (flag === "--batch") options.batch = Math.max(1, Number(inline ?? argv[++i]) || 500);
    else if (flag === "--wipe") options.wipe = true;
    else if (flag.startsWith("--")) {
      console.error(`Unknown option ${flag}`);
      process.exit(1);
    }
  }
  return options;
}

/* -------------------------------------------------------------------------- */
/* Batched writing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Push `rows` through `cypher` in chunks.
 *
 * Each chunk is its own transaction. That is deliberate: one transaction around
 * 112k relationships would hold the whole write set in the instance's memory,
 * and the free tier has 256 MB. The cost is that a failure leaves a partial
 * load — which is fine, because every statement is a `MERGE` and re-running
 * finishes the job.
 */
async function writeBatched(
  task: string,
  rows: readonly unknown[],
  cypher: string,
  batchSize: number,
): Promise<void> {
  if (rows.length === 0) {
    console.log(color.dim(`  ${task}: nothing to write`));
    return;
  }

  const report = progressReporter(task, rows.length);
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await runWrite(cypher, { rows: rows.slice(offset, offset + batchSize) });
    report(Math.min(offset + batchSize, rows.length));
  }
}

/** Deletes in chunks for the same reason writes go in chunks. */
async function wipe(batchSize: number): Promise<void> {
  process.stdout.write(color.dim("  wiping… "));
  let total = 0;
  for (;;) {
    const [row] = await runWrite<{ deleted: number }>(
      "MATCH (n) WITH n LIMIT $limit DETACH DELETE n RETURN count(n) AS deleted",
      { limit: batchSize * 4 },
    );
    const deleted = row?.deleted ?? 0;
    total += deleted;
    if (deleted === 0) break;
  }
  console.log(color.dim(`${total} nodes removed`));
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

async function seed(snapshot: GraphSnapshot, options: Options): Promise<void> {
  const { batch } = options;

  // Denormalised degree counts, written onto the node.
  //
  // Not an optimisation to skip — a load-bearing one. Every "how far am I from
  // this job" query needs each occupation's *total* essential-skill count
  // alongside the number the user has. Deriving that in Cypher means collecting
  // every candidate's full skill list, which on the free tier trips CognoDB's
  // 5-second BFS budget outright. With the count on the node it is a subtraction.
  const essentialCount = new Map<string, number>();
  const optionalCount = new Map<string, number>();
  for (const edge of snapshot.requires) {
    const tally = edge.essential ? essentialCount : optionalCount;
    tally.set(edge.occupation, (tally.get(edge.occupation) ?? 0) + 1);
  }

  await writeBatched(
    "occupations",
    snapshot.occupations.map((occupation) => ({
      ...occupation,
      essentialCount: essentialCount.get(occupation.uri) ?? 0,
      optionalCount: optionalCount.get(occupation.uri) ?? 0,
    })),
    `UNWIND $rows AS row
     MERGE (o:Occupation {uri: row.uri})
     SET o.label = row.label,
         o.description = row.description,
         o.altLabels = row.altLabels,
         o.iscoCode = row.iscoCode,
         o.iscoGroup = row.iscoGroup,
         o.iscoGroupLabel = row.iscoGroupLabel,
         o.essentialCount = row.essentialCount,
         o.optionalCount = row.optionalCount`,
    batch,
  );

  await writeBatched(
    "skills",
    snapshot.skills,
    `UNWIND $rows AS row
     MERGE (s:Skill {uri: row.uri})
     SET s.label = row.label,
         s.description = row.description,
         s.altLabels = row.altLabels,
         s.skillType = row.skillType,
         s.reuseLevel = row.reuseLevel`,
    batch,
  );

  await writeBatched(
    "skill themes",
    snapshot.skillGroups,
    `UNWIND $rows AS row
     MERGE (g:SkillGroup {uri: row.uri})
     SET g.label = row.label, g.description = row.description, g.code = row.code`,
    batch,
  );

  await writeBatched(
    "REQUIRES",
    snapshot.requires,
    `UNWIND $rows AS row
     MATCH (o:Occupation {uri: row.occupation})
     MATCH (s:Skill {uri: row.skill})
     MERGE (o)-[r:REQUIRES]->(s)
     SET r.essential = row.essential`,
    batch,
  );

  await writeBatched(
    "BROADER_THAN (occupations)",
    snapshot.occupationBroader,
    `UNWIND $rows AS row
     MATCH (narrow:Occupation {uri: row.narrow})
     MATCH (broad:Occupation {uri: row.broad})
     MERGE (narrow)-[:BROADER_THAN]->(broad)`,
    batch,
  );

  // The skill pillar mixes node kinds: a skill's parent is another skill or a
  // theme, and themes nest inside themes. Split by endpoint kind so every MATCH
  // is label-scoped and index-backed — an unlabelled `MATCH (n {uri: …})` is a
  // full scan, 14k times over.
  const skillUris = new Set(snapshot.skills.map((s) => s.uri));
  const groupUris = new Set(snapshot.skillGroups.map((g) => g.uri));
  const kind = (uri: string) => (skillUris.has(uri) ? "Skill" : groupUris.has(uri) ? "SkillGroup" : null);

  const byKind = {
    "Skill→Skill": [] as typeof snapshot.skillBroader,
    "Skill→SkillGroup": [] as typeof snapshot.skillBroader,
    "SkillGroup→SkillGroup": [] as typeof snapshot.skillBroader,
  };
  for (const edge of snapshot.skillBroader) {
    const from = kind(edge.narrow);
    const to = kind(edge.broad);
    if (!from || !to) continue;
    const key = `${from}→${to}` as keyof typeof byKind;
    if (key in byKind) byKind[key].push(edge);
  }

  for (const [key, rows] of Object.entries(byKind)) {
    const [from, to] = key.split("→");
    await writeBatched(
      `BROADER_THAN (${key})`,
      rows,
      `UNWIND $rows AS row
       MATCH (narrow:${from} {uri: row.narrow})
       MATCH (broad:${to} {uri: row.broad})
       MERGE (narrow)-[:BROADER_THAN]->(broad)`,
      batch,
    );
  }

  const adjacency = deriveAdjacency(snapshot);
  await writeBatched(
    "ADJACENT_TO (derived)",
    adjacency,
    `UNWIND $rows AS row
     MATCH (a:Occupation {uri: row.from})
     MATCH (b:Occupation {uri: row.to})
     MERGE (a)-[r:ADJACENT_TO]->(b)
     SET r.shared = row.shared, r.jaccard = row.jaccard`,
    batch,
  );
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/** Counts what actually landed. A seed that reports success without this is a guess. */
async function verify(snapshot: GraphSnapshot, expectedAdjacent: number): Promise<boolean> {
  const counts = await Promise.all([
    runRead<{ n: number }>("MATCH (o:Occupation) RETURN count(o) AS n"),
    runRead<{ n: number }>("MATCH (s:Skill) RETURN count(s) AS n"),
    runRead<{ n: number }>("MATCH (g:SkillGroup) RETURN count(g) AS n"),
    runRead<{ n: number }>("MATCH ()-[r:REQUIRES]->() RETURN count(r) AS n"),
    runRead<{ n: number }>("MATCH ()-[r:REQUIRES {essential: true}]->() RETURN count(r) AS n"),
    runRead<{ n: number }>("MATCH ()-[r:BROADER_THAN]->() RETURN count(r) AS n"),
    runRead<{ n: number }>("MATCH ()-[r:ADJACENT_TO]->() RETURN count(r) AS n"),
  ]);

  const [occupations, skills, groups, requires, essential, broader, adjacent] = counts.map(
    (rows) => rows[0]?.n ?? 0,
  );

  // The counts on the nodes must agree with the edges actually written, or
  // every gap calculation in the app is quietly wrong.
  const [countCheck] = await runRead<{ mismatched: number }>(
    `MATCH (o:Occupation)
     OPTIONAL MATCH (o)-[r:REQUIRES]->(:Skill) WHERE r.essential = true
     WITH o, count(r) AS actual
     WHERE actual <> o.essentialCount
     RETURN count(o) AS mismatched`,
  );

  const rows: [string, number, number][] = [
    ["Occupation", occupations, snapshot.occupations.length],
    ["  essentialCount wrong", countCheck?.mismatched ?? 0, 0],
    ["Skill", skills, snapshot.skills.length],
    ["SkillGroup", groups, snapshot.skillGroups.length],
    ["REQUIRES", requires, snapshot.requires.length],
    ["  of them essential", essential, snapshot.meta.counts.essentialRequires],
    [
      "BROADER_THAN",
      broader,
      snapshot.occupationBroader.length + snapshot.skillBroader.length,
    ],
    ["ADJACENT_TO", adjacent, expectedAdjacent],
  ];

  console.log(color.bold("\nIn the database"));
  let ok = true;
  for (const [name, actual, expected] of rows) {
    const match = actual === expected;
    ok &&= match;
    console.log(
      `  ${name.padEnd(22)}${String(actual).padStart(7)}  ${
        match ? color.green("= snapshot") : color.yellow(`≠ snapshot (${expected})`)
      }`,
    );
  }
  return ok;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

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

  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as GraphSnapshot;

  console.log(color.bold("\nSeed"));
  console.log(
    color.dim(
      `  ${snapshot.meta.source}\n  crawled ${snapshot.meta.fetchedAt} · skill detail: ${snapshot.meta.skillDetail} · batch ${options.batch}`,
    ),
  );

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

  if (options.wipe) await wipe(options.batch);

  await seed(snapshot, options);

  const ok = await verify(snapshot, deriveAdjacency(snapshot).length);
  console.log(color.dim(`\n  seeded in ${formatDuration((Date.now() - started) / 1000)}`));

  if (ok) {
    console.log(color.green("\n✓ Every count matches the snapshot. Next: Phase 3, the query layer.\n"));
  } else {
    console.log(
      color.yellow(
        "\n! Counts differ from the snapshot. Re-running is safe (everything is MERGE);\n  if they still differ, a batch failed — check the output above.\n",
      ),
    );
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(color.red(`\n✗ Seed failed: ${(error as Error).message}`));
    console.error(color.dim("  Everything is MERGE — re-run to continue from where it stopped.\n"));
    process.exitCode = 1;
  })
  .finally(closeDriver);
