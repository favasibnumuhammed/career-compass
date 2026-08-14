/**
 * Phase 4: exercise every API route over real HTTP.
 *
 *   npm run dev          # in one terminal
 *   npm run api          # in another
 *
 * Where `npm run queries` checks that the Cypher is right, this checks the
 * things only the HTTP layer can get wrong: status codes, the error contract,
 * caching headers, and whether a database error leaks Cypher to the client.
 *
 * It resolves the occupations it needs through `/api/search` rather than
 * hard-coding UUIDs — so the suite also proves the two endpoints compose the
 * way the UI will use them.
 *
 * Point it somewhere else with `BASE_URL=https://… npm run api`, which is how
 * the Phase 6 deployment gets checked.
 */
import { color } from "./report";
import type { AnalysisResult, OccupationDetail, OccupationPrefill, PathResult } from "../lib/types";
import type { ApiErrorBody } from "../lib/api";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

let passed = 0;
let failed = 0;

interface Result<T> {
  status: number;
  body: T;
  cacheControl: string | null;
  ms: number;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Result<T>> {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: response.status,
    body: parsed as T,
    cacheControl: response.headers.get("cache-control"),
    ms: Date.now() - started,
  };
}

/** Run one labelled request and assert something true of the response. */
async function check<T>(
  what: string,
  run: () => Promise<Result<T>>,
  expect: (result: Result<T>) => string,
  show?: (result: Result<T>) => void,
): Promise<Result<T> | null> {
  let result: Result<T>;
  try {
    result = await run();
  } catch (error) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${what.padEnd(52)}${color.red("request failed")}`);
    console.log(`      ${color.red((error as Error).message)}`);
    return null;
  }

  const problem = expect(result);
  const time = `${String(result.ms).padStart(6)}ms`;
  if (problem) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${what.padEnd(52)}${String(result.status).padStart(4)} ${time}`);
    console.log(`      ${color.red(problem)}`);
  } else {
    passed += 1;
    console.log(
      `  ${color.green("✓")} ${what.padEnd(52)}${String(result.status).padStart(4)} ` +
        `${result.ms > 3000 ? color.yellow(time) : color.dim(time)}`,
    );
  }
  show?.(result);
  return result;
}

const bullet = (line: string) => console.log(color.dim(`      ${line}`));

/** Every error response must be `{ error: { code, message } }` and nothing more revealing. */
function isError(result: Result<ApiErrorBody>, status: number, code: string): string {
  if (result.status !== status) return `expected ${status}, got ${result.status}`;
  const error = result.body?.error;
  if (!error) return "no error object in the body";
  if (error.code !== code) return `expected code "${code}", got "${error.code}"`;
  if (!error.message) return "error carries no message";
  // The one thing that must never reach a browser.
  if (/MATCH |RETURN |Neo\.|cypher/i.test(JSON.stringify(result.body))) {
    return `leaks database internals: ${JSON.stringify(result.body).slice(0, 120)}`;
  }
  return "";
}

const id = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(color.dim(`\n  ${BASE}`));

  // Preflight against liveness, not the database: a deployment with bad
  // credentials is still listening, and its 500 should be reported as a failed
  // check below rather than as "nothing is running".
  const reachable = await fetch(`${BASE}/api/live`).catch(() => null);
  if (!reachable) {
    console.error(
      color.red(`\n✗ Nothing is listening on ${BASE}.\n`) +
        color.dim("  Start the app first:  npm run dev\n"),
    );
    process.exitCode = 1;
    return;
  }

  /* ---- health ------------------------------------------------------------ */

  console.log(color.bold("\n/api/live · /api/health"));

  await check(
    "liveness answers without touching the database",
    () => call<{ status: string }>("GET", "/api/live"),
    (r) => (r.status === 200 && r.body.status === "ok" ? "" : `status ${r.status}, body ${JSON.stringify(r.body)}`),
  );

  await check(
    "reports the database as reachable",
    () => call<{ status: string }>("GET", "/api/health"),
    (r) => (r.status === 200 && r.body.status === "ok" ? "" : `status ${r.status}, body ${JSON.stringify(r.body)}`),
  );

  /* ---- search ------------------------------------------------------------ */

  console.log(color.bold("\n/api/search — Q0 · Q1"));

  await check(
    'skills, "man"',
    () => call<{ results: { label: string; demand: number }[] }>("GET", "/api/search?q=man&kind=skill"),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      if (!r.body.results?.length) return "no results";
      if (!r.cacheControl?.includes("max-age")) return `expected a cacheable response, got ${r.cacheControl}`;
      return "";
    },
    (r) => bullet(r.body.results.slice(0, 2).map((s) => `${s.label} (${s.demand})`).join(" · ")),
  );

  const occupations = await check(
    'occupations, "retail department"',
    () => call<{ results: { uri: string; label: string }[] }>("GET", "/api/search?q=retail%20department&kind=occupation"),
    (r) => (r.status === 200 && r.body.results?.length > 0 ? "" : "no results"),
    (r) => bullet(r.body.results.slice(0, 2).map((o) => o.label).join(" · ")),
  );

  await check(
    "one character searches nothing",
    () => call<{ results: unknown[] }>("GET", "/api/search?q=m&kind=skill"),
    (r) => (r.status === 200 && r.body.results.length === 0 ? "" : `expected an empty 200, got ${r.status}`),
  );

  await check(
    "unknown kind → 400",
    () => call<ApiErrorBody>("GET", "/api/search?q=man&kind=banana"),
    (r) => isError(r, 400, "bad_request"),
  );

  const home = occupations?.body.results.find((o) => o.label === "retail department manager");
  if (!home) {
    console.error(color.red("\n✗ Could not resolve the test occupation — is the graph seeded?\n"));
    process.exitCode = 1;
    return;
  }

  /* ---- occupation -------------------------------------------------------- */

  console.log(color.bold("\n/api/occupation/[id] — Q1 prefill · Q6 detail"));

  const prefill = await check(
    "prefill returns editable skill chips",
    () => call<OccupationPrefill>("GET", `/api/occupation/${id(home.uri)}/prefill`),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      const count = r.body.essentialSkills?.length ?? 0;
      return count > 0 ? "" : "no essential skills";
    },
    (r) => bullet(`${r.body.essentialSkills.length} skills for ${r.body.occupation.label}`),
  );

  const skills = prefill?.body.essentialSkills.map((s) => id(s.uri)) ?? [];

  await check(
    "detail without skills → coverage null",
    () => call<OccupationDetail>("GET", `/api/occupation/${id(home.uri)}`),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      if (r.body.coverage !== null) return `expected null coverage, got ${r.body.coverage}`;
      return r.body.essential.length > 0 ? "" : "no essential skills";
    },
    (r) => bullet(`${r.body.essential.length} essential · ${r.body.optional.length} optional · ${r.body.neighbours.length} neighbours`),
  );

  await check(
    "detail with skills → marked have/missing",
    () => call<OccupationDetail>("GET", `/api/occupation/${id(home.uri)}?skills=${skills.join(",")}`),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      if (typeof r.body.coverage !== "number") return "coverage should be a number";
      if (r.cacheControl !== "no-store") return `personalised response must not be cached: ${r.cacheControl}`;
      const held = r.body.essential.filter((s) => s.have).length;
      return held === r.body.essential.length ? "" : `${held}/${r.body.essential.length} marked as held — expected all`;
    },
    (r) => bullet(`coverage ${Math.round((r.body.coverage ?? 0) * 100)}% against its own skill set`),
  );

  await check(
    "full ESCO URI works as an id too",
    () => call<OccupationDetail>("GET", `/api/occupation/${encodeURIComponent(home.uri)}`),
    (r) => (r.status === 200 && r.body.uri === home.uri ? "" : `expected 200 for the long form, got ${r.status}`),
  );

  await check(
    "malformed id → 400",
    () => call<ApiErrorBody>("GET", "/api/occupation/not-an-id"),
    (r) => isError(r, 400, "bad_request"),
  );

  await check(
    "well-formed but unknown id → 404",
    () => call<ApiErrorBody>("GET", "/api/occupation/00000000-0000-4000-8000-000000000000"),
    (r) => isError(r, 404, "not_found"),
  );

  await check(
    "unknown id on prefill → 404",
    () => call<ApiErrorBody>("GET", "/api/occupation/00000000-0000-4000-8000-000000000000/prefill"),
    (r) => isError(r, 404, "not_found"),
  );

  /* ---- analyze ----------------------------------------------------------- */

  console.log(color.bold("\n/api/analyze — Q2 · Q3 · Q4 · Q7"));

  await check(
    "one payload: tiers, bridges, themes",
    () => call<AnalysisResult>("POST", "/api/analyze", { skills, exclude: [id(home.uri)] }),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`;
      if (!r.body.closest?.length) return "no closest roles";
      if (!r.body.bridges?.skills.length) return "no bridge skills — the hero card would be empty";
      if (!r.body.themes?.length) return "no gap themes";
      if (r.body.closest.some((role) => role.uri === home.uri)) return "the excluded occupation came back";
      const ordered = r.body.closest.every((role, i) => i === 0 || r.body.closest[i - 1].coverage >= role.coverage);
      if (!ordered) return "closest roles are not ordered by coverage";
      if (r.body.withinReach.some((role) => role.coverage < 0.5)) return "a within-reach role is below 50%";
      if (r.cacheControl !== "no-store") return `personalised response must not be cached: ${r.cacheControl}`;
      return "";
    },
    (r) => {
      const top = r.body.closest[0];
      const bridge = r.body.bridges.skills[0];
      bullet(`closest: ${top.label} at ${Math.round(top.coverage * 100)}% · within reach: ${r.body.withinReach.length}`);
      bullet(`bridge: learn "${bridge.label}" → advances ${bridge.advances} of ${r.body.bridges.pool}`);
      bullet(`themes: ${r.body.themes.slice(0, 2).map((t) => `${t.label} ${Math.round(t.share * 100)}%`).join(" · ")}`);
      bullet(`${r.body.meta.gaps} distinct gaps across ${r.body.meta.skills} skills`);
    },
  );

  await check(
    "no skills → 400, naming the field",
    () => call<ApiErrorBody>("POST", "/api/analyze", { skills: [] }),
    (r) => isError(r, 400, "bad_request") || (r.body.error.field === "skills" ? "" : "should name the skills field"),
  );

  await check(
    "skills that aren't ESCO ids → 400",
    () => call<ApiErrorBody>("POST", "/api/analyze", { skills: ["definitely-not-a-uuid"] }),
    (r) => isError(r, 400, "bad_request"),
  );

  await check(
    "malformed JSON → 400, not 500",
    () => call<ApiErrorBody>("POST", "/api/analyze", "{ not json"),
    (r) => isError(r, 400, "bad_request"),
  );

  /* ---- path -------------------------------------------------------------- */

  console.log(color.bold("\n/api/path — Q5"));

  const target = await call<{ results: { uri: string; label: string }[] }>(
    "GET",
    "/api/search?q=supply%20chain%20manager&kind=occupation",
  );
  const supplyChain = target.body.results.find((o) => o.label === "supply chain manager")!;

  await check(
    "retail department manager → supply chain manager",
    () => call<PathResult>("POST", "/api/path", { from: id(home.uri), to: id(supplyChain.uri), skills }),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status}`;
      if (!r.body.path) return "no path found";
      if (r.body.path.hops.length !== r.body.path.steps.length - 1) return "hops do not line up with steps";
      return "";
    },
    (r) => {
      const path = r.body.path!;
      bullet(path.steps.map((s) => s.label).join(" → "));
      bullet(`${path.totalLearn} skills over ${path.hops.length} hops (${path.strategy})`);
    },
  );

  const isolated = await call<{ results: { uri: string; label: string }[] }>(
    "GET",
    "/api/search?q=general%20practitioner&kind=occupation",
  );
  const gp = isolated.body.results.find((o) => o.label === "general practitioner")!;

  await check(
    "no route → 200 with a reason, not an error",
    () => call<PathResult>("POST", "/api/path", { from: id(home.uri), to: id(gp.uri), skills }),
    (r) => {
      if (r.status !== 200) return `expected 200, got ${r.status} — an unconnected pair is an answer`;
      if (r.body.path !== null) return "expected a null path";
      return r.body.reason === "unreachable" ? "" : `expected reason "unreachable", got ${r.body.reason}`;
    },
    () => bullet("both occupations exist; they are simply not connected"),
  );

  await check(
    "unknown destination → 404",
    () =>
      call<ApiErrorBody>("POST", "/api/path", {
        from: id(home.uri),
        to: "00000000-0000-4000-8000-000000000000",
      }),
    (r) => isError(r, 404, "not_found"),
  );

  await check(
    "malformed origin → 400",
    () => call<ApiErrorBody>("POST", "/api/path", { from: "nope", to: id(supplyChain.uri) }),
    (r) => isError(r, 400, "bad_request") || (r.body.error.field === "from" ? "" : "should name the from field"),
  );

  /* ---- summary ----------------------------------------------------------- */

  console.log(
    failed === 0
      ? color.green(`\n✓ ${passed} checks passed. Next: Phase 5 is done — run npm run pages.\n`)
      : color.red(`\n✗ ${failed} of ${passed + failed} checks failed.\n`),
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(color.red(`\n✗ API check failed: ${(error as Error).message}\n`));
  process.exitCode = 1;
});
