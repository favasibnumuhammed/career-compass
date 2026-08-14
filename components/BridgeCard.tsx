import { percent, plural, reuseLevel, sentence } from "@/lib/format";
import type { BridgeSkillResult } from "@/lib/types";
import { EmptyState } from "./EmptyState";

/**
 * The hero. One skill, and what learning it would do for you.
 *
 * This card is the whole product, so it is the only place in the app allowed to
 * shout — full-bleed accent surface, the skill name at display size, and the
 * roles it moves you towards named rather than counted. Every other surface is
 * quiet so that this one can do that.
 *
 * **The number is stated with its denominator, always.** "Advances 57 roles" is
 * unfalsifiable; "advances 57 of your 100 nearest roles" tells the reader what
 * was measured and lets them disagree with it. The plan's original claim
 * ("unlocks 9 roles" — meaning *completes*) turned out to be unsupported by
 * ESCO data for anybody (PLAN.md §11), so the honest number is the one on
 * screen and `completes` is reported underneath rather than quietly dropped.
 */
export function BridgeCard({ result }: { result: BridgeSkillResult }) {
  const [hero, ...runnersUp] = result.skills;

  if (!hero) {
    return (
      <EmptyState title="No single skill stands out yet">
        Bridge skills are found by looking at what the roles nearest you have in common. With this
        few skills there aren&apos;t enough nearby roles to compare. Add two or three more and this
        is usually the most useful thing on the page.
      </EmptyState>
    );
  }

  const share = result.pool > 0 ? hero.advances / result.pool : 0;
  const level = reuseLevel(hero.reuseLevel);

  return (
    <section
      aria-labelledby="bridge-heading"
      className="overflow-hidden rounded-2xl border border-accent-line bg-accent-soft"
    >
      <div className="p-6 sm:p-8">
        <h2
          id="bridge-heading"
          className="text-[11px] font-semibold uppercase tracking-[0.09em] text-accent"
        >
          Learn this next
        </h2>

        <p className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-ink sm:text-[32px]">
          {sentence(hero.label)}
        </p>

        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-soft sm:text-base">
          It moves you closer to{" "}
          <strong className="font-semibold text-ink">{hero.advances}</strong> of the{" "}
          <strong className="font-semibold text-ink">{result.pool}</strong> roles you are nearest to
          — more than any other single skill.
        </p>

        {/* The share bar makes 57-of-100 a proportion you can see at a glance,
            which is the claim's whole substance. */}
        <div className="mt-5 max-w-md">
          <div
            className="h-2 overflow-hidden rounded-full bg-surface"
            role="img"
            aria-label={`${percent(share)} of the candidate roles`}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(share * 100, 2)}%` }} />
          </div>
          <p className="mt-2 text-[13px] text-ink-muted">
            {percent(share)} of the roles closest to you · they sit at {percent(hero.meanCoverage)}{" "}
            coverage on average
            {level ? ` · ${level.toLowerCase()}` : ""}
          </p>
        </div>

        {hero.examples.length > 0 && (
          <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
            <span className="text-ink-muted">Including</span>{" "}
            {hero.examples.slice(0, 4).map((example, i, shown) => (
              <span key={example}>
                <span className="font-medium text-ink">{sentence(example)}</span>
                {i < shown.length - 1 ? ", " : ""}
              </span>
            ))}
            .
          </p>
        )}

        <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
          {hero.completes === 0 ? (
            <>
              On its own it qualifies you for none of them outright — on ESCO data no single skill
              ever does, because occupations differ by six or more essential skills. &ldquo;Closer&rdquo;
              is the honest claim, and it is still the difference between one course and twelve.
            </>
          ) : (
            <>It would complete {plural(hero.completes, "role")} outright.</>
          )}
        </p>
      </div>

      {runnersUp.length > 0 && (
        <div className="border-t border-accent-line bg-surface/60 px-6 py-5 sm:px-8">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-muted">
            Next best
          </h3>
          <ul className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {runnersUp.slice(0, 6).map((skill) => (
              <li key={skill.uri} className="min-w-0">
                <p className="truncate text-sm font-medium text-ink" title={sentence(skill.label)}>
                  {sentence(skill.label)}
                </p>
                <p className="text-[13px] text-ink-muted tabular-nums">
                  advances {skill.advances} of {result.pool}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
