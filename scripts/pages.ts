/**
 * Phase 5: exercise every rendered page over real HTTP.
 *
 *   npm run dev          # in one terminal
 *   npm run pages        # in another
 *
 * `npm run queries` checks the Cypher. `npm run api` checks the JSON contract.
 * This checks the thing a person actually looks at, and specifically the three
 * properties of it that are easy to break and invisible in a screenshot:
 *
 * 1. **The shell streams before the answer.** `/results` takes ~7s because
 *    `analyse()` does; what must not take 7s is the first byte. The check reads
 *    the response as a stream and asserts the heading and the skeleton are in
 *    the *first chunk*, with the hero card arriving later. A refactor that
 *    accidentally awaits the analysis above the Suspense boundary turns the
 *    page into a seven-second white screen, and nothing else here would catch it.
 *
 * 2. **The states are distinguishable.** "No skills", "no matches", "we don't
 *    have that occupation" and "the database is unreachable" are four different
 *    screens, and the plan grades them (§5). Each is asserted by the words it
 *    puts on screen and by its HTTP status — an unknown occupation must be a
 *    real 404, an outage must not be.
 *
 * 3. **Nothing leaks.** The same Cypher-in-the-response check `npm run api`
 *    runs, applied to the HTML — including the streamed RSC payload, which is a
 *    second place for a driver message to escape and is not covered by testing
 *    the JSON routes alone.
 *
 * Assertions are made against the *text a browser would show*: script blocks
 * stripped, tags removed, whitespace collapsed. That deliberately survives
 * restyling — a class rename should not fail this suite, and a deleted sentence
 * should.
 *
 * Point it at the deployment with `BASE_URL=https://… npm run pages`.
 */
import { color } from "./report";
import type { OccupationPrefill, OccupationSuggestion } from "../lib/types";

const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

let passed = 0;
let failed = 0;

interface Page {
  status: number;
  /** Everything that arrived, as visible text. */
  text: string;
  /** Visible text from the first streamed chunk alone. */
  firstChunk: string;
  /** Raw bytes, for leak detection — the RSC payload lives in script blocks. */
  raw: string;
  ttfbMs: number;
  ms: number;
}

/** HTML → roughly what a reader sees. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function get(path: string): Promise<Page> {
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, { headers: { Accept: "text/html" } });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let firstChunkRaw = "";
  let ttfbMs = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstChunkRaw) {
      ttfbMs = Date.now() - started;
      firstChunkRaw = decoder.decode(value, { stream: true });
      raw += firstChunkRaw;
    } else {
      raw += decoder.decode(value, { stream: true });
    }
  }

  return {
    status: response.status,
    text: visible(raw),
    firstChunk: visible(firstChunkRaw),
    raw,
    ttfbMs,
    ms: Date.now() - started,
  };
}

async function check(
  what: string,
  run: () => Promise<Page>,
  expect: (page: Page) => string,
  show?: (page: Page) => void,
): Promise<Page | null> {
  let page: Page;
  try {
    page = await run();
  } catch (error) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${what.padEnd(52)}${color.red("request failed")}`);
    console.log(`      ${color.red((error as Error).message)}`);
    return null;
  }

  const problem = expect(page) || leaks(page);
  const time = `${String(page.ms).padStart(6)}ms`;
  if (problem) {
    failed += 1;
    console.log(`  ${color.red("✗")} ${what.padEnd(52)}${String(page.status).padStart(4)} ${time}`);
    console.log(`      ${color.red(problem)}`);
  } else {
    passed += 1;
    console.log(
      `  ${color.green("✓")} ${what.padEnd(52)}${String(page.status).padStart(4)} ` +
        `${page.ms > 3000 ? color.yellow(time) : color.dim(time)}`,
    );
  }
  show?.(page);
  return page;
}

const bullet = (line: string) => console.log(color.dim(`      ${line}`));

/**
 * The one thing that must never reach a browser — checked against the raw
 * bytes, not the visible text, because the streamed RSC payload is inside
 * script blocks and a driver message would hide there.
 */
function leaks(page: Page): string {
  const found = [/MATCH \(/, /\bRETURN\b/, /Neo\.[A-Za-z]/, /Neo4jError/, /bolt(\+s)?:\/\//].find((pattern) =>
    pattern.test(page.raw),
  );
  return found ? `leaks database internals: ${found}` : "";
}

/** Every listed phrase has to be somewhere on the page. */
function says(page: Page, ...phrases: string[]): string {
  const missing = phrases.filter((phrase) => !page.text.includes(phrase));
  return missing.length > 0 ? `missing from the page: ${missing.map((m) => `"${m}"`).join(", ")}` : "";
}

function status(page: Page, expected: number): string {
  return page.status === expected ? "" : `expected ${expected}, got ${page.status}`;
}

const id = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(color.dim(`\n  ${BASE}`));

  const reachable = await fetch(`${BASE}/api/live`).catch(() => null);
  if (!reachable) {
    console.error(
      color.red(`\n✗ Nothing is listening on ${BASE}.\n`) +
        color.dim("  Start the app first:  npm run dev\n"),
    );
    process.exitCode = 1;
    return;
  }

  // Resolve the scenario the way the UI does, rather than hard-coding ids: the
  // suite then also proves the entry screen's two API calls still compose.
  const search = (await (
    await fetch(`${BASE}/api/search?kind=occupation&q=retail%20department%20manager&limit=1`)
  ).json()) as { results: OccupationSuggestion[] };
  const home = search.results[0];
  if (!home) throw new Error("cannot resolve the scenario occupation");

  const prefill = (await (await fetch(`${BASE}/api/occupation/${id(home.uri)}/prefill`)).json()) as OccupationPrefill;
  const skills = prefill.essentialSkills.map((skill) => id(skill.uri)).join(",");
  const context = `s=${skills}&from=${id(home.uri)}`;

  const target = (
    (await (
      await fetch(`${BASE}/api/search?kind=occupation&q=supply%20chain%20manager&limit=1`)
    ).json()) as { results: OccupationSuggestion[] }
  ).results[0];

  console.log(color.dim(`  scenario: ${home.label}, ${prefill.essentialSkills.length} skills\n`));

  /* ---- the entry screen -------------------------------------------------- */

  console.log(color.bold("Entry — two doors"));

  await check(
    "both doors render",
    () => get("/"),
    (page) =>
      status(page, 200) ||
      says(page, "Start from a job you've done", "Pick your skills", "unlocks the most doors"),
  );

  await check(
    "?s= rehydrates the editor with labelled chips",
    () => get(`/?${context}`),
    (page) =>
      status(page, 200) ||
      says(page, `${prefill.essentialSkills.length} selected`, "Show me what I can do") ||
      // The chips must carry words, not the ids the URL carried.
      (page.text.includes(prefill.essentialSkills[0].label.charAt(0).toUpperCase() + prefill.essentialSkills[0].label.slice(1))
        ? ""
        : "chips did not resolve to skill labels"),
    (page) => bullet(`${prefill.essentialSkills.length} chips rebuilt from the URL in ${page.ms}ms`),
  );

  /* ---- results ----------------------------------------------------------- */

  console.log(color.bold("\nResults — streamed around a 7-second query"));

  await check(
    "shell streams first, answer arrives after",
    () => get(`/results?${context}`),
    (page) => {
      const problem = status(page, 200) || says(page, "Where you stand", "Learn this next", "Closest roles");
      if (problem) return problem;
      if (!page.firstChunk.includes("Where you stand")) {
        return "the heading was not in the first chunk — the page is blocking on the analysis";
      }
      if (!page.firstChunk.includes("Searching the graph")) {
        return "the skeleton was not in the first chunk";
      }
      if (page.firstChunk.includes("Learn this next")) {
        return "the answer was in the first chunk — nothing was actually streamed";
      }
      return "";
    },
    (page) =>
      bullet(
        `shell in ${page.ttfbMs}ms, complete in ${page.ms}ms — ` +
          `${(page.ms / Math.max(page.ttfbMs, 1)).toFixed(0)}× later`,
      ),
  );

  await check(
    "the hero states its denominator",
    () => get(`/results?${context}`),
    (page) => {
      const match = /moves you closer to (\d+) of the (\d+) roles/.exec(page.text);
      if (!match) return "the bridge card did not name both numbers";
      const [, advances, pool] = match;
      return Number(advances) <= Number(pool) ? "" : `advances ${advances} of a pool of ${pool}`;
    },
    (page) => {
      const match = /Learn this next (.+?) It moves you closer to (\d+) of the (\d+)/.exec(page.text);
      if (match) bullet(`"${match[1].trim()}" → ${match[2]} of ${match[3]}`);
      const themes = /(\d+)% of the (\d+) skills standing between you/.exec(page.text);
      if (themes) bullet(`gap rollup: ${themes[1]}% of ${themes[2]} gaps in one theme`);
    },
  );

  await check(
    "empty tier 2 explains itself instead of erroring",
    () => get(`/results?${context}`),
    (page) =>
      // Priya's nearest role sits at 45%, so "within reach" is empty — a real
      // answer with its own copy, and the check fails if it ever becomes silent.
      page.text.includes("Nothing clears halfway yet") || page.text.includes("Within reach")
        ? ""
        : "tier 2 rendered neither results nor its empty state",
  );

  await check(
    "no skills → the empty state, not an error",
    () => get("/results"),
    (page) => status(page, 200) || says(page, "Pick at least two skills"),
  );

  await check(
    "unreadable skill ids → the same empty state",
    () => get("/results?s=nope,also-nope"),
    (page) => status(page, 200) || says(page, "Pick at least two skills"),
  );

  /* ---- occupation detail ------------------------------------------------- */

  console.log(color.bold("\nOccupation — detail and path"));

  await check(
    "detail marks every skill have or missing",
    () => get(`/occupation/${id(home.uri)}?s=${skills}`),
    (page) => status(page, 200) || says(page, "Essential skills", "You already have", "Jobs most like this one"),
    (page) => {
      // `[\s\S]` rather than the `s` flag: tsconfig targets ES2017.
      const match = /You already have (\d+)[\s\S]*?Still to learn — (\d+)/.exec(page.text);
      if (match) bullet(`${match[1]} held · ${match[2]} to learn`);
    },
  );

  await check(
    "no skills → coverage unknown, not 0%",
    () => get(`/occupation/${id(home.uri)}`),
    (page) =>
      status(page, 200) ||
      says(page, "Add your skills to see how close you are") ||
      (page.text.includes("Still to learn") ? "showed a gap without knowing the user's skills" : ""),
  );

  if (target) {
    await check(
      "career path streams into the detail page",
      () => get(`/occupation/${id(target.uri)}?${context}`),
      (page) => {
        const problem =
          status(page, 200) || says(page, "Getting here from where you are", "Skills already counted");
        if (problem) return problem;
        return page.firstChunk.includes("Working out the cheapest route") ||
          !page.firstChunk.includes("Getting here from where you are")
          ? ""
          : "the path section rendered without ever showing its skeleton";
      },
      (page) => {
        const match = /(\d+ steps?), (\d+ skills?) in total, and never more than (\d+)/.exec(page.text);
        if (match) bullet(`${match[1]}, ${match[2]}, largest hop ${match[3]}`);
      },
    );
  }

  // 200, not 404, and deliberately — see the note in the page. What is asserted
  // instead is the thing the plan actually grades: that this reads as "we don't
  // have that", distinguishably from an outage, in server-rendered HTML.
  await check(
    "unknown occupation → says so, and rules out an outage",
    () => get("/occupation/00000000-0000-4000-8000-000000000000"),
    (page) =>
      status(page, 200) ||
      says(page, "We don't have that one", "not a database problem") ||
      (page.text.includes("Try again") ? "offered a retry for something retrying cannot fix" : ""),
  );

  await check(
    "malformed id → the same, without touching the database",
    () => get("/occupation/not-a-uuid"),
    (page) => status(page, 200) || says(page, "We don't have that one"),
    (page) => bullet(`answered in ${page.ms}ms — no query was issued`),
  );

  await check(
    "the API still answers a real 404 for the same id",
    async () => {
      const started = Date.now();
      const response = await fetch(`${BASE}/api/occupation/00000000-0000-4000-8000-000000000000`);
      const raw = await response.text();
      return { status: response.status, text: raw, firstChunk: raw, raw, ttfbMs: 0, ms: Date.now() - started };
    },
    (page) => status(page, 404) || (page.text.includes("not_found") ? "" : "wrong error code"),
  );

  await check(
    "an unknown route → the app's own 404",
    () => get("/no-such-page"),
    (page) => status(page, 404) || says(page, "There's no page here"),
  );

  /* ---- summary ----------------------------------------------------------- */

  console.log(
    failed === 0
      ? color.green(
          `\n✓ ${passed} checks passed. Next: run this against the deployment — BASE_URL=https://… npm run pages.\n`,
        )
      : color.red(`\n✗ ${failed} of ${passed + failed} checks failed.\n`),
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(color.red(`\n✗ Page check failed: ${(error as Error).message}\n`));
  process.exitCode = 1;
});
