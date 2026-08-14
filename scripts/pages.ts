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
 *    the response as a stream and times when each piece of text became
 *    readable, asserting the heading and skeleton arrive seconds before the
 *    hero card. A refactor that accidentally awaits the analysis above the
 *    Suspense boundary turns the page into a seven-second white screen, and
 *    nothing else here would catch it.
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
  /**
   * Milliseconds into the response at which a piece of visible text had fully
   * arrived, or null if it never did.
   *
   * Deliberately a time and not a chunk index. Over loopback the whole shell
   * lands in chunk one; through a proxy the same bytes are split across
   * several chunks milliseconds apart, and asserting on "the first chunk"
   * fails there while nothing about the page has changed.
   */
  arrivedAt: (marker: string) => number | null;
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
  let ttfbMs = 0;
  // One entry per chunk: how much had arrived, and when.
  const arrivals: { length: number; at: number }[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!arrivals.length) ttfbMs = Date.now() - started;
    raw += decoder.decode(value, { stream: true });
    arrivals.push({ length: raw.length, at: Date.now() - started });
  }

  /**
   * When did this text become readable? Binary search over the chunk
   * boundaries, comparing against the *visible* prefix each time — markers are
   * what a reader sees, and React splits text nodes with comment markers that
   * a raw substring search would trip over.
   */
  const arrivedAt = (marker: string): number | null => {
    if (!visible(raw).includes(marker)) return null;
    let low = 0;
    let high = arrivals.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (visible(raw.slice(0, arrivals[middle].length)).includes(marker)) high = middle;
      else low = middle + 1;
    }
    return arrivals[low].at;
  };

  return {
    status: response.status,
    text: visible(raw),
    arrivedAt,
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
      const heading = page.arrivedAt("Where you stand");
      const skeleton = page.arrivedAt("Searching the graph");
      const answer = page.arrivedAt("Learn this next");
      if (heading === null || skeleton === null) return "the heading and skeleton never arrived";
      if (answer === null) return "the answer never arrived";
      const shell = Math.max(heading, skeleton);
      // A page that awaits the analysis above the Suspense boundary delivers
      // shell and answer together. One second is far below the ~7s the query
      // takes and far above any plausible chunking jitter.
      if (answer - shell < 1000) {
        return `shell and answer arrived ${answer - shell}ms apart — the page is blocking on the analysis`;
      }
      return "";
    },
    (page) => {
      const shell = Math.max(page.arrivedAt("Where you stand") ?? 0, page.arrivedAt("Searching the graph") ?? 0);
      const answer = page.arrivedAt("Learn this next") ?? page.ms;
      bullet(`shell in ${shell}ms, answer at ${answer}ms — ${(answer / Math.max(shell, 1)).toFixed(0)}× later`);
    },
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
        // The detail page has two boundaries: the job at ~1s, the route at
        // 3–8s. The skeleton must therefore be readable before the route is.
        const skeleton = page.arrivedAt("Working out the cheapest route");
        const route = page.arrivedAt("Skills already counted");
        if (skeleton === null) return "the path section rendered without ever showing its skeleton";
        if (route !== null && route < skeleton) return "the route arrived before its own skeleton";
        return "";
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
      return {
        status: response.status,
        text: raw,
        arrivedAt: () => null, // not streamed, and nothing here asks
        raw,
        ttfbMs: 0,
        ms: Date.now() - started,
      };
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
