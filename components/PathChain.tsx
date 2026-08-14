import Link from "next/link";
import { percent, plural, sentence } from "@/lib/format";
import { occupationHref } from "@/lib/params";
import type { CareerPath, PathResult } from "@/lib/types";
import { EmptyState } from "./EmptyState";
import { SkillPill } from "./SkillPill";

/**
 * Q5 — the route from one job to another, with the price of every step.
 *
 * Two presentations of the same route, because they answer different questions.
 * The rail across the top is *where does this go* — readable in one glance,
 * which is the plan's "horizontal chain". The list underneath is *what does
 * each move cost*, which needs room for a dozen named skills per hop and would
 * be unreadable squeezed into a horizontal lane.
 *
 * **The honest framing, which is not the one the plan assumed.** PLAN.md §1
 * imagined stepping stones being cheaper than the leap — "three hops, seven
 * skills". Measured, Priya to supply chain manager is 16 skills as a single
 * jump or 38 spread over three, and §12 says so. Stepping stones are not a
 * discount; they are a route where you hold a real job at every step and no
 * single move is more than a manageable number of skills. That is a genuinely
 * good answer, and it is the one this component states.
 */
export function PathChain({ result, skills }: { result: PathResult; skills: readonly string[] }) {
  if (!result.path) {
    return (
      <EmptyState title="No route between these two jobs">
        They are more than six similarity steps apart, or one of them has no close neighbours at
        all. The similarity network is derived from shared essential skills, so two jobs with
        nothing in common genuinely have no path — that is an answer about the careers, not a
        failure of the search.
      </EmptyState>
    );
  }

  const path = result.path;
  const direct = path.hops.length === 1;
  const biggestHop = Math.max(0, ...path.hops.map((hop) => hop.learn.length));

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line p-6">
        <Rail path={path} skills={skills} />
      </div>

      <div className="border-b border-line bg-sunk px-6 py-4">
        <p className="text-[15px] leading-relaxed text-ink-soft">
          {direct ? (
            <>
              These two jobs are already neighbours:{" "}
              <strong className="font-semibold text-ink">{plural(path.totalLearn, "skill")}</strong>{" "}
              separates them, in one move.
            </>
          ) : (
            <>
              <strong className="font-semibold text-ink">
                {plural(path.hops.length, "step")}
              </strong>
              , {plural(path.totalLearn, "skill")} in total, and never more than {biggestHop} at
              once. Each stop is a job you can hold while you learn the next set — the route is not
              cheaper than the leap, it is survivable.
            </>
          )}
        </p>
      </div>

      <ol className="divide-y divide-line">
        {path.hops.map((hop, index) => {
          const to = path.steps[index + 1];
          return (
            <li key={`${hop.from}-${hop.to}`} className="p-6">
              <div className="flex items-baseline justify-between gap-4">
                <h4 className="text-[15px] font-semibold tracking-tight text-ink">
                  <span className="mr-2 text-ink-muted tabular-nums">{index + 1}.</span>
                  {sentence(to?.label ?? "")}
                </h4>
                <p className="shrink-0 text-[13px] tabular-nums text-ink-muted">
                  {percent(hop.jaccard)} alike
                </p>
              </div>

              {hop.learn.length === 0 ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Nothing new to learn for this step — you already hold everything it needs.
                </p>
              ) : (
                <>
                  <p className="mt-3 text-[13px] text-ink-muted">
                    Learn {plural(hop.learn.length, "skill")} to get here:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {hop.learn.map((skill) => (
                      <SkillPill key={skill.uri} label={skill.label} tone="gap" />
                    ))}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>

      <p className="border-t border-line px-6 py-3 text-[13px] text-ink-muted">
        Skills already counted for an earlier step are not charged again later.{" "}
        {path.strategy === "bidirectional"
          ? "Found by searching from both ends — CognoDB's shortestPath runs out of budget past three hops."
          : "Found directly; where several routes tie, the cheapest to walk wins."}
      </p>
    </div>
  );
}

/** The route at a glance: every stop, in order, wrapping on narrow screens. */
function Rail({ path, skills }: { path: CareerPath; skills: readonly string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {path.steps.map((step, index) => (
        <li key={step.uri} className="flex items-center gap-2">
          {index > 0 && (
            <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-ink-muted" fill="none">
              <path
                d="M3 8h9m0 0-3.2-3.2M12 8l-3.2 3.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {index === 0 || index === path.steps.length - 1 ? (
            <span
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                index === 0
                  ? "border-have-line bg-have-soft text-have"
                  : "border-accent-line bg-accent-soft text-accent"
              }`}
            >
              {sentence(step.label)}
            </span>
          ) : (
            <Link
              href={occupationHref(step.uri, skills)}
              className="rounded-lg border border-line bg-sunk px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            >
              {sentence(step.label)}
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
