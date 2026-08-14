/**
 * Phase 0 gate: openCypher capability probe.
 *
 * CognoDB speaks openCypher over Bolt, not Neo4j's full Cypher dialect. Several
 * of the planned queries lean on specific language constructs — relationship
 * property maps in patterns (Q2/Q3/Q4/Q6), list comprehensions (Q3/Q4),
 * shortestPath (Q5), variable-length traversal (Q5/Q7). This script finds out
 * which of those the live instance actually supports, before any of them get
 * written.
 *
 * Run:  npm run probe
 *
 * It writes a handful of throwaway `:_Probe` nodes and deletes them again; it
 * touches nothing else in the database.
 */
import "dotenv/config";
import { runRead, runWrite, verifyConnection, closeDriver, DbUnreachableError, DbAuthError } from "../lib/db";
import { getEnv, EnvError } from "../lib/env";

type Status = "pass" | "fail" | "info";

interface Check {
  id: string;
  label: string;
  /** Which planned queries stop working if this is unsupported. */
  needed_by: string;
  critical: boolean;
  run: () => Promise<string>;
}

interface Result extends Check {
  status: Status;
  note: string;
}

const color = process.stdout.isTTY
  ? {
      green: (s: string) => `\x1b[32m${s}\x1b[0m`,
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    }
  : {
      green: (s: string) => s,
      red: (s: string) => s,
      yellow: (s: string) => s,
      dim: (s: string) => s,
      bold: (s: string) => s,
    };

function expect(condition: boolean, note: string): string {
  if (!condition) throw new Error(`unexpected result: ${note}`);
  return note;
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                      */
/* -------------------------------------------------------------------------- */

const checks: Check[] = [
  {
    id: "params",
    label: "Bolt parameters",
    needed_by: "every query",
    critical: true,
    run: async () => {
      const rows = await runRead<{ v: string }>("RETURN $value AS v", { value: "ok" });
      return expect(rows[0]?.v === "ok", "round-tripped a parameter");
    },
  },
  {
    id: "integers",
    label: "Integer normalisation",
    needed_by: "API payloads",
    critical: true,
    run: async () => {
      const rows = await runRead<{ n: number }>("RETURN 42 AS n");
      return expect(typeof rows[0]?.n === "number", `count came back as ${typeof rows[0]?.n}`);
    },
  },
  {
    id: "constraint",
    label: "Unique constraints",
    needed_by: "seed (idempotent MERGE)",
    critical: false,
    run: async () => {
      await runWrite(
        "CREATE CONSTRAINT probe_unique IF NOT EXISTS FOR (n:_Probe) REQUIRE n.id IS UNIQUE",
      );
      await runWrite("DROP CONSTRAINT probe_unique IF EXISTS");
      return "created and dropped";
    },
  },
  {
    id: "index",
    label: "Property indexes",
    needed_by: "Q0/Q1 typeahead",
    critical: true,
    run: async () => {
      await runWrite("CREATE INDEX probe_idx IF NOT EXISTS FOR (n:_Probe) ON (n.id)");
      await runWrite("DROP INDEX probe_idx IF EXISTS");
      return "created and dropped";
    },
  },
  {
    id: "text_index",
    label: "TEXT indexes",
    needed_by: "Q0/Q1 prefix search (optional)",
    critical: false,
    run: async () => {
      await runWrite("CREATE TEXT INDEX probe_text IF NOT EXISTS FOR (n:_Probe) ON (n.id)");
      await runWrite("DROP INDEX probe_text IF EXISTS");
      return "supported — use for label prefix search";
    },
  },
  {
    id: "unwind_merge",
    label: "UNWIND batch MERGE",
    needed_by: "seed loader",
    critical: true,
    run: async () => {
      const rows = await runWrite<{ written: number }>(
        `UNWIND $rows AS row
         MERGE (n:_Probe {id: row.id})
         SET n.tag = row.tag
         RETURN count(n) AS written`,
        {
          rows: [
            { id: "a", tag: "alpha" },
            { id: "b", tag: "bravo" },
            { id: "c", tag: "charlie" },
          ],
        },
      );
      return expect(rows[0]?.written === 3, `wrote ${rows[0]?.written} nodes in one batch`);
    },
  },
  {
    id: "rel_create",
    label: "Relationship properties",
    needed_by: "REQUIRES {essential}",
    critical: true,
    run: async () => {
      await runWrite(
        `MATCH (a:_Probe {id: 'a'}), (b:_Probe {id: 'b'}), (c:_Probe {id: 'c'})
         MERGE (a)-[:_P {essential: true}]->(b)
         MERGE (b)-[:_P {essential: false}]->(c)`,
      );
      return "wrote typed relationships with properties";
    },
  },
  {
    id: "rel_prop_pattern",
    label: "Rel property map in pattern",
    needed_by: "Q2, Q3, Q4, Q6",
    critical: true,
    run: async () => {
      const rows = await runRead<{ id: string }>(
        "MATCH (:_Probe {id: 'a'})-[:_P {essential: true}]->(b) RETURN b.id AS id",
      );
      return expect(rows[0]?.id === "b", "matched [:_P {essential: true}] inline");
    },
  },
  {
    id: "list_comprehension",
    label: "List comprehensions",
    needed_by: "Q3, Q4 (gap computation)",
    critical: true,
    run: async () => {
      const rows = await runRead<{ missing: string[] }>(
        "WITH $required AS required, $mine AS mine RETURN [x IN required WHERE NOT x IN mine] AS missing",
        { required: ["x", "y", "z"], mine: ["y"] },
      );
      return expect(rows[0]?.missing.length === 2, `computed a gap of ${rows[0]?.missing.length}`);
    },
  },
  {
    id: "predicates",
    label: "all() / any() predicates",
    needed_by: "Q2 (subset match)",
    critical: true,
    run: async () => {
      const rows = await runRead<{ ok: boolean }>(
        "WITH $required AS required, $mine AS mine RETURN all(x IN required WHERE x IN mine) AS ok",
        { required: ["a", "b"], mine: ["a", "b", "c"] },
      );
      return expect(rows[0]?.ok === true, "subset test evaluated");
    },
  },
  {
    id: "aggregation",
    label: "collect() / size() / DISTINCT",
    needed_by: "Q3, Q4",
    critical: true,
    run: async () => {
      const rows = await runRead<{ n: number }>(
        `MATCH (n:_Probe)
         WITH DISTINCT n
         WITH collect(n.id) AS ids
         RETURN size(ids) AS n`,
      );
      return expect(rows[0]?.n === 3, `collected ${rows[0]?.n} distinct ids`);
    },
  },
  {
    id: "var_length",
    label: "Variable-length traversal",
    needed_by: "Q5, Q7",
    critical: true,
    run: async () => {
      const rows = await runRead<{ n: number }>(
        "MATCH (:_Probe {id: 'a'})-[:_P*1..3]->(x) RETURN count(DISTINCT x) AS n",
      );
      return expect(rows[0]?.n === 2, `reached ${rows[0]?.n} nodes within 3 hops`);
    },
  },
  {
    id: "shortest_path",
    label: "shortestPath()",
    needed_by: "Q5 (career path)",
    critical: false,
    run: async () => {
      const rows = await runRead<{ len: number }>(
        `MATCH (a:_Probe {id: 'a'}), (c:_Probe {id: 'c'})
         MATCH p = shortestPath((a)-[:_P*1..5]->(c))
         RETURN length(p) AS len`,
      );
      return expect(rows[0]?.len === 2, `found a ${rows[0]?.len}-hop shortest path`);
    },
  },
  {
    id: "path_ordering",
    label: "Path fallback (ORDER BY length)",
    needed_by: "Q5 fallback if shortestPath is unsupported",
    critical: true,
    run: async () => {
      const rows = await runRead<{ len: number }>(
        `MATCH p = (:_Probe {id: 'a'})-[:_P*1..5]->(:_Probe {id: 'c'})
         RETURN length(p) AS len
         ORDER BY len ASC
         LIMIT 1`,
      );
      return expect(rows[0]?.len === 2, `manual BFS fallback works (${rows[0]?.len} hops)`);
    },
  },
  {
    id: "call_subquery",
    label: "CALL { } subqueries",
    needed_by: "Q4 (nice to have, avoidable)",
    critical: false,
    run: async () => {
      const rows = await runRead<{ total: number }>(
        `MATCH (n:_Probe)
         CALL { WITH n MATCH (n)-[:_P]->(m) RETURN count(m) AS c }
         RETURN sum(c) AS total`,
      );
      return expect(rows[0]?.total === 2, `subquery aggregated ${rows[0]?.total} edges`);
    },
  },
  {
    id: "starts_with",
    label: "STARTS WITH prefix match",
    needed_by: "Q0, Q1 typeahead",
    critical: true,
    run: async () => {
      const rows = await runRead<{ n: number }>(
        "MATCH (n:_Probe) WHERE n.id STARTS WITH $prefix RETURN count(n) AS n",
        { prefix: "a" },
      );
      return expect(rows[0]?.n === 1, `prefix search returned ${rows[0]?.n}`);
    },
  },
  {
    id: "apoc",
    label: "APOC availability",
    needed_by: "nothing — the plan deliberately avoids it",
    critical: false,
    run: async () => {
      await runRead("RETURN apoc.version() AS v");
      return "present (unexpected, but harmless)";
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function cleanup(): Promise<void> {
  try {
    await runWrite("MATCH (n:_Probe) DETACH DELETE n");
    await runWrite("DROP CONSTRAINT probe_unique IF EXISTS");
    await runWrite("DROP INDEX probe_idx IF EXISTS");
    await runWrite("DROP INDEX probe_text IF EXISTS");
  } catch {
    console.warn(color.yellow("\n  ! cleanup of :_Probe nodes did not complete — check manually"));
  }
}

function report(results: Result[]): void {
  const width = Math.max(...results.map((r) => r.label.length));
  console.log(`\n${color.bold("Capability")}${" ".repeat(width - 10 + 2)}Result`);
  console.log(color.dim("─".repeat(width + 60)));

  for (const r of results) {
    const badge =
      r.status === "pass"
        ? color.green("PASS")
        : r.status === "fail"
          ? color.red("FAIL")
          : color.yellow("INFO");
    console.log(
      `${r.label.padEnd(width + 2)}${badge}  ${r.note}\n${" ".repeat(width + 8)}${color.dim(`needed by: ${r.needed_by}`)}`,
    );
  }

  const failed = results.filter((r) => r.status === "fail");
  const blocking = failed.filter((r) => r.critical);

  console.log(color.dim("─".repeat(width + 60)));
  console.log(
    `${results.filter((r) => r.status === "pass").length} passed · ${failed.length} failed · ${
      results.filter((r) => r.status === "info").length
    } informational`,
  );

  if (blocking.length > 0) {
    console.log(
      color.red(
        `\n✗ ${blocking.length} critical capability/ies missing. Adjust the query plan before Phase 3:`,
      ),
    );
    for (const r of blocking) console.log(color.red(`    · ${r.label} — needed by ${r.needed_by}`));
  } else if (failed.length > 0) {
    console.log(
      color.yellow(
        "\n! Only non-critical gaps. Each has a documented fallback in PLAN.md — note them and continue.",
      ),
    );
  } else {
    console.log(color.green("\n✓ Every planned Cypher construct is supported. Phase 1 is clear."));
  }
}

async function main(): Promise<void> {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(color.red(`\n✗ ${error.message}\n`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(color.bold("\nCognoDB capability probe"));
  console.log(color.dim(`  target: ${env.COGNODB_URI}`));
  console.log(color.dim(`  user:   ${env.COGNODB_USER}`));

  try {
    const info = await verifyConnection();
    console.log(color.green(`  ✓ connected${info.address ? ` (${info.address})` : ""}`));
  } catch (error) {
    if (error instanceof DbAuthError) {
      console.error(color.red("\n✗ Authentication failed. Check COGNODB_USER / COGNODB_PASSWORD.\n"));
    } else if (error instanceof DbUnreachableError) {
      console.error(
        color.red(
          "\n✗ Could not reach the instance. Check COGNODB_URI, that the instance is running,\n  and that your network allows outbound TLS on the Bolt port.\n",
        ),
      );
    } else {
      console.error(color.red(`\n✗ ${(error as Error).message}\n`));
    }
    process.exitCode = 1;
    await closeDriver();
    return;
  }

  const results: Result[] = [];
  for (const check of checks) {
    try {
      const note = await check.run();
      results.push({ ...check, status: check.id === "apoc" ? "info" : "pass", note });
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      results.push({
        ...check,
        status: check.id === "apoc" ? "info" : "fail",
        note: check.id === "apoc" ? "absent (expected — the plan uses no APOC)" : message,
      });
    }
  }

  await cleanup();
  report(results);

  if (results.some((r) => r.status === "fail" && r.critical)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(color.red(`\nProbe crashed: ${(error as Error).message}`));
    process.exitCode = 1;
  })
  .finally(closeDriver);
