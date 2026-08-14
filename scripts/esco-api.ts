/**
 * A small client for the public ESCO REST API (https://ec.europa.eu/esco/api).
 *
 * Why the API and not the CSV bundle the plan called for: the CSV download is
 * gated behind a form that requires an email address, acceptance of the reuse
 * terms and a CAPTCHA — not automatable. The API is public, unauthenticated,
 * and carries exactly the same content: essential/optional skill relations,
 * skill type, reuse level, and both hierarchies.
 *
 * The price is ~17,000 requests at roughly 8/s, so this module is built around
 * three things: bounded concurrency, retry with backoff, and an on-disk
 * append-only cache so an interrupted run resumes instead of starting over.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const ESCO_API_BASE = process.env.ESCO_API_BASE ?? "https://ec.europa.eu/esco/api";
export const ESCO_LANGUAGE = "en";

/* -------------------------------------------------------------------------- */
/* Response shapes                                                             */
/* -------------------------------------------------------------------------- */

/** An entry inside `_links`. Thin by design — a URI, a label, sometimes a code. */
export interface EscoLink {
  uri: string;
  title?: string;
  code?: string;
  /** Present on skill links: `http://data.europa.eu/esco/skill-type/{skill,knowledge}`. */
  skillType?: string;
}

/** A literal in one language, as ESCO returns descriptions. */
interface EscoLiteral {
  literal?: string;
  mimetype?: string;
}

/**
 * Every ESCO resource — occupation, skill, concept, taxonomy — comes back in
 * this shape. Note that `description` and `preferredLabel` arrive in all 28
 * languages regardless of the `language` parameter; that only sets `title`.
 */
export interface EscoResource {
  uri: string;
  className?: string;
  title?: string;
  code?: string;
  status?: string;
  preferredLabel?: Record<string, string>;
  alternativeLabel?: Record<string, string[]>;
  description?: Record<string, EscoLiteral>;
  _links?: Record<string, EscoLink | EscoLink[]>;
}

/* -------------------------------------------------------------------------- */
/* Field accessors                                                             */
/* -------------------------------------------------------------------------- */

/** `_links` values are sometimes an object, sometimes an array. Always give an array. */
export function links(resource: EscoResource | null, relation: string): EscoLink[] {
  const value = resource?._links?.[relation];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function label(resource: EscoResource): string {
  return resource.preferredLabel?.[ESCO_LANGUAGE] ?? resource.title ?? "";
}

export function description(resource: EscoResource): string {
  return (resource.description?.[ESCO_LANGUAGE]?.literal ?? "").trim();
}

/** Synonyms, deduped and capped — they feed typeahead, they are not a corpus. */
export function alternativeLabels(resource: EscoResource, cap = 6): string[] {
  const all = resource.alternativeLabel?.[ESCO_LANGUAGE] ?? [];
  const preferred = label(resource).toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alt of all) {
    const trimmed = alt.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || key === preferred || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

/** `http://data.europa.eu/esco/skill-type/knowledge` → `knowledge`. */
export function lastPathSegment(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const segment = uri.split("/").filter(Boolean).pop();
  return segment || undefined;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

export class EscoNotFoundError extends Error {
  readonly name = "EscoNotFoundError";
  constructor(readonly uri: string) {
    super(`ESCO has no resource at ${uri}`);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counters for the run summary — a 429 count is the signal to slow down. */
export const stats = { requests: 0, retries: 0, rateLimited: 0, bytes: 0 };

async function fetchOnce(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        // Identify the caller: this is a public API, and a nameless crawler is
        // the kind of thing that gets a range blocked.
        "User-Agent": "career-compass/0.1 (ESCO dataset ingest; contact via repository)",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET a resource. Returns `null` for a 404 — ESCO's graph has a few dangling
 * references and one missing skill should not abort a 20-minute ingest.
 */
export async function escoGet(
  path: string,
  params: Record<string, string>,
): Promise<EscoResource | null> {
  const url = `${ESCO_API_BASE}${path}?${new URLSearchParams(params).toString()}`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      stats.requests += 1;
      const response = await fetchOnce(url);

      if (response.status === 404) return null;

      if (RETRYABLE_STATUS.has(response.status)) {
        if (response.status === 429) stats.rateLimited += 1;
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} (not retryable)`);

      const body = await response.text();
      stats.bytes += body.length;
      return JSON.parse(body) as EscoResource;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      stats.retries += 1;
      // Exponential backoff with jitter: 0.5s, 1s, 2s, 4s (±25%).
      const base = 500 * 2 ** (attempt - 1);
      await sleep(base * (0.75 + Math.random() * 0.5));
    }
  }

  throw new Error(
    `ESCO request failed after ${MAX_ATTEMPTS} attempts: ${url}\n  ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export const getOccupation = (uri: string) =>
  escoGet("/resource/occupation", { uri, language: ESCO_LANGUAGE });
export const getSkill = (uri: string) => escoGet("/resource/skill", { uri, language: ESCO_LANGUAGE });
export const getConcept = (uri: string) =>
  escoGet("/resource/concept", { uri, language: ESCO_LANGUAGE });
export const getTaxonomy = (uri: string) =>
  escoGet("/resource/taxonomy", { uri, language: ESCO_LANGUAGE });

/* -------------------------------------------------------------------------- */
/* Bounded concurrency                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Run `worker` over `items` with at most `concurrency` in flight. Results are
 * not collected — every worker is expected to persist what it produces, which
 * is what makes the run resumable.
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
      done += 1;
      onProgress?.(done, items.length);
    }
  });

  await Promise.all(runners);
}

/* -------------------------------------------------------------------------- */
/* Resumable cache                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An append-only NDJSON file of already-fetched records, keyed by `uri`.
 *
 * Caching the *normalised* record rather than the raw response matters: raw
 * ESCO responses average 38 KB (all 28 languages of every label), so a raw
 * cache of this crawl would be ~650 MB. The normalised form is ~5 MB.
 */
export class RecordCache<T extends { uri: string }> {
  private readonly records = new Map<string, T>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as T;
        this.records.set(record.uri, record);
      } catch {
        // A torn last line from an interrupted run. Drop it; it will be refetched.
      }
    }
  }

  get size(): number {
    return this.records.size;
  }

  has(uri: string): boolean {
    return this.records.has(uri);
  }

  get(uri: string): T | undefined {
    return this.records.get(uri);
  }

  values(): T[] {
    return [...this.records.values()];
  }

  /** Write-through: in memory and on disk, so a Ctrl-C loses at most one record. */
  put(record: T): void {
    this.records.set(record.uri, record);
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

/**
 * Writes a large JSON document incrementally, one record per line.
 *
 * Synchronous on purpose: `JSON.stringify` on the whole snapshot would build a
 * ~20 MB string, and a `WriteStream` would need drain handling for 300k small
 * writes. This needs neither. One record per line also means the committed
 * `graph.json` produces a readable git diff instead of one unreadable line.
 */
export class JsonLineWriter {
  private readonly fd: number;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
  }

  write(text: string): void {
    writeSync(this.fd, text);
  }

  /** `"key": [` … one JSON record per line … `]`. */
  array(key: string, records: readonly unknown[], last = false): void {
    this.write(`"${key}": [\n`);
    records.forEach((record, index) => {
      this.write(JSON.stringify(record) + (index === records.length - 1 ? "\n" : ",\n"));
    });
    this.write(`]${last ? "\n" : ",\n"}`);
  }

  close(): void {
    closeSync(this.fd);
  }
}
