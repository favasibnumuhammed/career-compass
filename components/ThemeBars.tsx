import { percent, plural, sentence } from "@/lib/format";
import type { GapTheme } from "@/lib/types";
import { EmptyState } from "./EmptyState";

/**
 * Q7 — the gaps, named by theme instead of listed.
 *
 * The point of this section is the reframe: a person looking at fifty-two
 * missing skills sees an impossible list, and the same person told "29% of them
 * are communication and collaboration" sees a course to take. It is the only
 * part of the results that makes the total *smaller* rather than larger.
 *
 * Shares sum to 100% because `gapRollup` assigns each skill to exactly one
 * theme even when ESCO gives it two parents — so the headline percentage means
 * what it appears to mean.
 */
export function ThemeBars({ themes, gaps }: { themes: readonly GapTheme[]; gaps: number }) {
  if (themes.length === 0) {
    return (
      <EmptyState title="Nothing to roll up">
        Your gaps didn&apos;t resolve to any ESCO theme — which happens when there are very few of
        them, or when they sit in corners of the hierarchy that have no named parent.
      </EmptyState>
    );
  }

  const [top] = themes;

  return (
    <div className="rounded-xl border border-line bg-surface p-6">
      <p className="text-[15px] leading-relaxed text-ink-soft sm:text-base">
        <strong className="font-semibold text-ink">{percent(top.share)}</strong> of the{" "}
        {plural(gaps, "skill")} standing between you and these roles sit under{" "}
        <strong className="font-semibold text-ink">{sentence(top.label)}</strong>. That is one
        problem, not {gaps}.
      </p>

      <ul className="mt-6 space-y-4">
        {themes.map((theme) => (
          <li key={theme.uri}>
            <div className="flex items-baseline justify-between gap-4">
              <p className="min-w-0 truncate text-sm font-medium text-ink" title={sentence(theme.label)}>
                {sentence(theme.label)}
              </p>
              <p className="shrink-0 text-[13px] tabular-nums text-ink-muted">
                {theme.count} · {percent(theme.share)}
              </p>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunk">
              <div
                className="h-full rounded-full bg-gap"
                style={{ width: `${Math.max(theme.share * 100, 1.5)}%` }}
              />
            </div>
            {theme.examples.length > 0 && (
              <p className="mt-1.5 truncate text-[13px] text-ink-muted">
                {theme.examples.slice(0, 3).map(sentence).join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
