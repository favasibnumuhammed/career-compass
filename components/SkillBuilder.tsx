"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ApiErrorBody } from "@/lib/api";
import { escoId } from "@/lib/esco";
import { sentence } from "@/lib/format";
import { resultsHref } from "@/lib/params";
import type { OccupationPrefill, OccupationSuggestion, SkillRef } from "@/lib/types";
import { OccupationTypeahead, SkillTypeahead } from "./Typeahead";

/**
 * The entry screen: two doors, and the editable skill set behind both.
 *
 * "List your skills" is an intimidating first request — most people cannot
 * produce seventeen of them on demand, and the ones they do produce are the
 * ones they happen to be proud of rather than the ones ESCO indexes. So the
 * primary door is **a job title**: name something you have done, and Q1
 * prefills the essential skills ESCO associates with it, as chips you then
 * edit. PLAN.md §5 calls this the thing that makes the app usable by a
 * non-technical person, and it is the reason `/prefill` exists as its own
 * endpoint.
 *
 * The second door is there because the first one fails for career changers
 * whose real job has no ESCO equivalent, and for anyone who wants to describe
 * themselves rather than their last employer.
 *
 * **Both doors land in the same editor**, because the prefill is a starting
 * point and not an answer — the whole premise is that the user knows things
 * their job title does not imply, and misses things it does.
 */
type Stage = "doors" | "job" | "editor";

/** Below this the results are noise: a single skill matches half of ESCO. */
const MIN_SKILLS = 2;

export function SkillBuilder({
  initialSkills = [],
  initialFrom = null,
}: {
  initialSkills?: SkillRef[];
  initialFrom?: { uri: string; label: string } | null;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>(initialSkills.length > 0 ? "editor" : "doors");
  const [skills, setSkills] = useState<SkillRef[]>(initialSkills);
  const [from, setFrom] = useState<{ uri: string; label: string } | null>(initialFrom);
  const [prefilling, setPrefilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();

  const chosen = new Set(skills.map((skill) => skill.uri));

  function add(skill: SkillRef) {
    setSkills((current) =>
      current.some((existing) => existing.uri === skill.uri) ? current : [...current, skill],
    );
  }

  function remove(uri: string) {
    setSkills((current) => current.filter((skill) => skill.uri !== uri));
  }

  async function pickJob(occupation: OccupationSuggestion) {
    setPrefilling(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/occupation/${escoId(occupation.uri)}/prefill`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
        setNotice(
          body?.error?.message ?? "Couldn't load that job's skills. Try again in a moment.",
        );
        return;
      }
      const prefill = (await response.json()) as OccupationPrefill;
      // Merge rather than replace: someone who added a few skills first and
      // then remembered their job title should not lose the first few.
      setSkills((current) => {
        const seen = new Set(current.map((skill) => skill.uri));
        return [...current, ...prefill.essentialSkills.filter((skill) => !seen.has(skill.uri))];
      });
      setFrom({ uri: prefill.occupation.uri, label: prefill.occupation.label });
      setStage("editor");
    } catch {
      setNotice("Couldn't load that job's skills. Check your connection and try again.");
    } finally {
      setPrefilling(false);
    }
  }

  function submit() {
    startSubmit(() => {
      router.push(resultsHref(skills.map((skill) => skill.uri), from?.uri));
    });
  }

  if (stage === "doors") {
    return (
      <Doors
        onJob={() => {
          setNotice(null);
          setStage("job");
        }}
        onSkills={() => {
          setNotice(null);
          setStage("editor");
        }}
      />
    );
  }

  if (stage === "job") {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <BackLink onClick={() => setStage("doors")} />
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">
          Start from a job you&apos;ve done
        </h2>
        <p className="mt-1.5 max-w-lg text-[15px] leading-relaxed text-ink-soft">
          Pick the closest match and we&apos;ll fill in the skills ESCO associates with it. You get
          to edit every one of them — the list is a starting point, not a verdict.
        </p>
        <div className="mt-6 max-w-xl">
          <OccupationTypeahead onSelect={pickJob} busy={prefilling} autoFocus />
          {notice && (
            <p className="mt-2 text-[13px] text-danger" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
    );
  }

  const enough = skills.length >= MIN_SKILLS;

  return (
    <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
      <BackLink onClick={() => setStage("doors")} />

      {from ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {sentence(from.label)}
          </h2>
          <button
            type="button"
            onClick={() => {
              setFrom(null);
              setStage("job");
            }}
            className="text-[13px] text-accent underline underline-offset-2"
          >
            change job
          </button>
        </div>
      ) : (
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">Your skills</h2>
      )}

      <p className="mt-1.5 max-w-lg text-[15px] leading-relaxed text-ink-soft">
        {from
          ? "These are the skills ESCO treats as essential for that job. Remove anything you never actually did, and add what you picked up elsewhere."
          : "Add everything you can do — including things from outside work. The more you list, the more the results are about you rather than about a job title."}
      </p>

      <div className="mt-6 max-w-xl">
        <SkillTypeahead onSelect={add} chosen={chosen} autoFocus={!from} />
        {notice && (
          <p className="mt-2 text-[13px] text-danger" role="status">
            {notice}
          </p>
        )}
      </div>

      <div className="mt-7">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {skills.length > 0 ? `${skills.length} selected` : "Nothing selected yet"}
          </h3>
          {skills.length > 0 && (
            <button
              type="button"
              onClick={() => setSkills([])}
              className="text-[13px] text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              clear all
            </button>
          )}
        </div>

        {skills.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-line-strong bg-sunk px-4 py-6 text-center text-sm text-ink-muted">
            Skills you add will appear here.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {skills.map((skill) => (
              <li key={skill.uri}>
                <button
                  type="button"
                  onClick={() => remove(skill.uri)}
                  aria-label={`Remove ${skill.label}`}
                  className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-have-line bg-have-soft py-1 pl-2.5 pr-2 text-[13px] leading-5 text-have transition-colors hover:border-danger-line hover:bg-danger-soft hover:text-danger"
                >
                  <span className="truncate">{sentence(skill.label)}</span>
                  <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0 opacity-60 group-hover:opacity-100" fill="none">
                    <path d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-line pt-6">
        <button
          type="button"
          onClick={submit}
          disabled={!enough || submitting}
          className="inline-flex h-11 items-center rounded-lg bg-accent px-5 text-[15px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Searching the graph…" : "Show me what I can do"}
        </button>
        <p className="text-[13px] text-ink-muted" aria-live="polite">
          {enough
            ? "This takes about seven seconds — it runs four graph queries against a free-tier instance."
            : `Pick at least ${MIN_SKILLS} skills. One skill matches half of ESCO and tells you nothing.`}
        </p>
      </div>
    </div>
  );
}

function Doors({ onJob, onSkills }: { onJob: () => void; onSkills: () => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <button
        type="button"
        onClick={onJob}
        className="group rounded-2xl border border-accent-line bg-accent-soft p-6 text-left transition-shadow hover:shadow-lg hover:shadow-black/5 sm:p-7"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent text-accent-ink">
          <svg viewBox="0 0 20 20" aria-hidden className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2.75" y="6.25" width="14.5" height="10" rx="1.75" />
            <path d="M7.25 6.25V5a1.5 1.5 0 0 1 1.5-1.5h2.5a1.5 1.5 0 0 1 1.5 1.5v1.25" />
          </svg>
        </span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">
          Start from a job you&apos;ve done
        </h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-ink-soft">
          Name it and we&apos;ll fill in the skills it usually needs. Edit from there.
        </p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
          Recommended
          <Arrow />
        </span>
      </button>

      <button
        type="button"
        onClick={onSkills}
        className="group rounded-2xl border border-line bg-surface p-6 text-left transition-shadow hover:shadow-lg hover:shadow-black/5 sm:p-7"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-lg bg-sunk text-ink-soft">
          <svg viewBox="0 0 20 20" aria-hidden className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 6.25h12M4 10h12M4 13.75h7" strokeLinecap="round" />
          </svg>
        </span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight text-ink">Pick your skills</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-ink-soft">
          Build the list yourself. Better if your job has no neat title.
        </p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft">
          Start typing
          <Arrow />
        </span>
      </button>
    </div>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" fill="none">
      <path d="M3 8h9m0 0-3.2-3.2M12 8l-3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-ink"
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none">
        <path d="M13 8H4m0 0 3.2-3.2M4 8l3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Both ways in
    </button>
  );
}
