"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { sentence } from "@/lib/format";
import type { ApiErrorBody } from "@/lib/api";
import type { OccupationSuggestion, SkillSuggestion } from "@/lib/types";

/**
 * The one place in the UI that talks to `/api/search`.
 *
 * Everything else renders from `lib/queries.ts` on the server (see
 * `lib/load.ts`), but a typeahead fires on keystrokes in a browser, so this is
 * a genuine HTTP client and Phase 4's route earns its keep.
 *
 * Three things make it usable against a database that answers in ~1 second:
 *
 * 1. **Debounce, then abort.** 220 ms of quiet before a request, and the
 *    previous request is aborted when a new one starts. Without the abort, a
 *    fast typist's answers arrive out of order and the list flickers backwards.
 * 2. **Two characters minimum,** enforced here as well as in the route, so the
 *    common case of a single stray keystroke never leaves the browser.
 * 3. **The old results stay put while new ones load.** Blanking the list on
 *    every keystroke makes a one-second query feel like a broken one.
 *
 * A failed search says so inline rather than throwing: the input is the only
 * thing on the screen, and replacing it with an error panel would strand
 * someone who simply typed while the instance was waking up.
 */
interface SearchResponse<T> {
  kind: string;
  query: string;
  results: T[];
}

const MIN_QUERY = 2;
const DEBOUNCE_MS = 220;

interface TypeaheadProps<T> {
  kind: "skill" | "occupation";
  label: string;
  placeholder: string;
  onSelect: (item: T) => void;
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Already-chosen items, shown greyed rather than hidden — see below. */
  isChosen?: (item: T) => boolean;
  autoFocus?: boolean;
  busy?: boolean;
}

function Typeahead<T>({
  kind,
  label,
  placeholder,
  onSelect,
  getKey,
  renderItem,
  isChosen,
  autoFocus,
  busy,
}: TypeaheadProps<T>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The effect only *schedules*; every state change happens inside the timer or
  // in an event handler. Clearing state synchronously in an effect body sets off
  // a cascading render, and on a list this size that is a visible stutter.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) return;

    const timer = setTimeout(async () => {
      setLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(
          `/api/search?kind=${kind}&q=${encodeURIComponent(trimmed)}&limit=8`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
          setError(body?.error?.message ?? "Search is unavailable right now.");
          setResults([]);
          return;
        }
        const body = (await response.json()) as SearchResponse<T>;
        setError(null);
        setResults(body.results);
        setActive(0);
        setOpen(true);
      } catch (cause) {
        // An abort is this component cancelling itself, not a failure.
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError("Search is unavailable right now.");
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, kind]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Backspacing below the minimum clears the list here, not in the effect. */
  function retype(value: string) {
    setQuery(value);
    setOpen(true);
    if (value.trim().length < MIN_QUERY) {
      abortRef.current?.abort();
      setResults([]);
      setLoading(false);
      setError(null);
    }
  }

  const choose = useCallback(
    (item: T) => {
      onSelect(item);
      setQuery("");
      setResults([]);
      setOpen(false);
      inputRef.current?.focus();
    },
    [onSelect],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (results.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      const item = results[active];
      if (item) choose(item);
    }
  }

  const showList = open && results.length > 0;
  const noMatches = !loading && !error && query.trim().length >= MIN_QUERY && results.length === 0;

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative mt-2">
        <input
          id={`${listId}-input`}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          autoComplete="off"
          // The input is the only control on its step; not focusing it makes
          // the step look inert.
          autoFocus={autoFocus}
          disabled={busy}
          value={query}
          placeholder={placeholder}
          onChange={(event) => retype(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          className="h-11 w-full rounded-lg border border-line bg-surface pl-10 pr-10 text-[15px] text-ink placeholder:text-ink-muted disabled:opacity-60"
        />
        <svg
          viewBox="0 0 20 20"
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4.5 -translate-y-1/2 text-ink-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <circle cx="9" cy="9" r="5.5" />
          <path d="m13.2 13.2 3.3 3.3" strokeLinecap="round" />
        </svg>
        {(loading || busy) && (
          <span className="absolute right-3 top-1/2 size-4 -translate-y-1/2">
            <span className="block size-4 animate-spin rounded-full border-2 border-line border-t-accent" />
          </span>
        )}
      </div>

      {error && (
        <p className="mt-2 text-[13px] text-danger" role="status">
          {error}
        </p>
      )}
      {noMatches && (
        <p className="mt-2 text-[13px] text-ink-muted" role="status">
          Nothing in ESCO starts with &ldquo;{query.trim()}&rdquo;. Try a shorter or more common
          wording.
        </p>
      )}

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1.5 max-h-80 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-lg shadow-black/5"
        >
          {results.map((item, index) => {
            const chosen = isChosen?.(item) ?? false;
            return (
              <li
                key={getKey(item)}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={chosen}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (!chosen) choose(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  index === active ? "bg-sunk" : ""
                } ${chosen ? "cursor-default opacity-45" : ""}`}
              >
                {renderItem(item)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function SkillTypeahead({
  onSelect,
  chosen,
  autoFocus,
}: {
  onSelect: (skill: SkillSuggestion) => void;
  chosen: ReadonlySet<string>;
  autoFocus?: boolean;
}) {
  return (
    <Typeahead<SkillSuggestion>
      kind="skill"
      label="Add a skill"
      placeholder="Type a skill — “manage budgets”, “customer service”…"
      autoFocus={autoFocus}
      onSelect={onSelect}
      getKey={(skill) => skill.uri}
      // Chosen skills stay in the list, greyed. Removing them silently makes the
      // user wonder whether the search is broken; showing them says "already got it".
      isChosen={(skill) => chosen.has(skill.uri)}
      renderItem={(skill) => (
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-ink">{sentence(skill.label)}</span>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">
            {chosen.has(skill.uri) ? "added" : `${skill.demand} jobs`}
          </span>
        </div>
      )}
    />
  );
}

export function OccupationTypeahead({
  onSelect,
  busy,
  autoFocus,
}: {
  onSelect: (occupation: OccupationSuggestion) => void;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <Typeahead<OccupationSuggestion>
      kind="occupation"
      label="What job have you done?"
      placeholder="Type a job title — “retail department manager”…"
      autoFocus={autoFocus}
      busy={busy}
      onSelect={onSelect}
      getKey={(occupation) => occupation.uri}
      renderItem={(occupation) => (
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-ink">{sentence(occupation.label)}</span>
            {occupation.matchedAlt && (
              <span className="block truncate text-[12px] text-ink-muted">
                also known as {occupation.matchedAlt}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">
            {occupation.essentialCount} skills
          </span>
        </div>
      )}
    />
  );
}
