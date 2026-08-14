/**
 * Phase 2: constraints and indexes.
 *
 * Run before `npm run seed`, and safe to re-run — every statement is
 * `IF NOT EXISTS`.
 *
 * Two jobs:
 *
 *   - **Uniqueness on `uri`.** The seed is built on `MERGE`, which needs an
 *     index to be anything other than a full scan, and needs uniqueness to be
 *     idempotent. Without it, a re-run quietly doubles the graph.
 *   - **Label indexes for typeahead.** Q0/Q1 match on `label STARTS WITH`.
 *     The Phase 0 probe found `CREATE TEXT INDEX` unsupported on CognoDB, so
 *     these are plain property indexes — which `STARTS WITH` can still use, and
 *     at 13k skills that is comfortably fast.
 */
import "dotenv/config";
import { closeDriver, DbAuthError, DbUnreachableError, runRead, runWrite, verifyConnection } from "../lib/db";
import { EnvError, getEnv } from "../lib/env";
import { color } from "./report";

interface Statement {
  what: string;
  why: string;
  cypher: string;
}

const statements: Statement[] = [
  {
    what: "constraint Occupation.uri",
    why: "idempotent MERGE during seed",
    cypher: "CREATE CONSTRAINT occupation_uri IF NOT EXISTS FOR (o:Occupation) REQUIRE o.uri IS UNIQUE",
  },
  {
    what: "constraint Skill.uri",
    why: "idempotent MERGE during seed",
    cypher: "CREATE CONSTRAINT skill_uri IF NOT EXISTS FOR (s:Skill) REQUIRE s.uri IS UNIQUE",
  },
  {
    what: "constraint SkillGroup.uri",
    why: "idempotent MERGE during seed",
    cypher: "CREATE CONSTRAINT skill_group_uri IF NOT EXISTS FOR (g:SkillGroup) REQUIRE g.uri IS UNIQUE",
  },
  {
    what: "index Occupation.label",
    why: "Q1 occupation typeahead",
    cypher: "CREATE INDEX occupation_label IF NOT EXISTS FOR (o:Occupation) ON (o.label)",
  },
  {
    what: "index Skill.label",
    why: "Q0 skill typeahead",
    cypher: "CREATE INDEX skill_label IF NOT EXISTS FOR (s:Skill) ON (s.label)",
  },
];

/**
 * Constraints were only "supported" in the Phase 0 probe, not guaranteed. If
 * one is rejected, fall back to a plain index: `MERGE` still behaves correctly
 * against a single-threaded seed, it just loses the uniqueness guarantee.
 */
async function applyWithFallback(statement: Statement): Promise<string> {
  try {
    await runWrite(statement.cypher);
    return "ok";
  } catch (error) {
    if (!statement.cypher.startsWith("CREATE CONSTRAINT")) throw error;

    const label = statement.cypher.match(/FOR \((\w+):(\w+)\)/);
    const fallback = `CREATE INDEX ${statement.what.split(" ")[1].replace(".", "_").toLowerCase()}_idx IF NOT EXISTS FOR (${label?.[1]}:${label?.[2]}) ON (${label?.[1]}.uri)`;
    await runWrite(fallback);
    return `constraint rejected — fell back to a plain index (${(error as Error).message.split("\n")[0]})`;
  }
}

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

  console.log(color.bold("\nSchema"));

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

  for (const statement of statements) {
    const note = await applyWithFallback(statement);
    const badge = note === "ok" ? color.green("✓") : color.yellow("!");
    console.log(`  ${badge} ${statement.what.padEnd(28)}${color.dim(statement.why)}`);
    if (note !== "ok") console.log(`    ${color.yellow(note)}`);
  }

  // Report what the server actually has, rather than what we asked for.
  // CognoDB lists constraints separately from indexes, so ask for both.
  for (const [statement, kind] of [
    ["SHOW CONSTRAINTS", "constraints"],
    ["SHOW INDEXES", "indexes"],
  ] as const) {
    try {
      const rows = await runRead<{ name: string }>(statement);
      console.log(color.dim(`  ${kind}: ${rows.map((row) => row.name).join(", ") || "none"}`));
    } catch {
      console.log(color.dim(`  (${statement} unsupported — skipping verification)`));
    }
  }

  console.log(color.green("\n✓ Schema ready. Next: npm run seed\n"));
}

main()
  .catch((error) => {
    console.error(color.red(`\n✗ Schema failed: ${(error as Error).message}\n`));
    process.exitCode = 1;
  })
  .finally(closeDriver);
