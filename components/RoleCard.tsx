import Link from "next/link";
import { CLOSENESS_LABEL, closeness, plural, sentence } from "@/lib/format";
import { occupationHref } from "@/lib/params";
import type { RoleMatch } from "@/lib/types";
import { SkillPillList } from "./SkillPill";

/**
 * One matched occupation.
 *
 * The card leads with the ring rather than the job title because the question
 * on this screen is comparative — *which of these am I closest to* — and a
 * column of rings answers that in one pass down the page, where a column of
 * percentages written as text does not.
 *
 * Gaps are shown as skills, not as a count. "12 skills short" is a wall; three
 * named skills and a "+9 more" is a decision the reader can actually make.
 */
export function RoleCard({
  role,
  skills,
  from,
}: {
  role: RoleMatch;
  skills: readonly string[];
  from?: string | null;
}) {
  const band = closeness(role.coverage);

  return (
    <Link
      href={occupationHref(role.uri, skills, from)}
      className="group block rounded-xl border border-line bg-surface p-5 transition-colors hover:border-line-strong hover:bg-sunk"
    >
      <div className="flex items-start gap-4">
        <MiniRing coverage={role.coverage} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink group-hover:text-accent">
            {sentence(role.label)}
          </h3>
          <p className="mt-0.5 truncate text-[13px] text-ink-muted">
            {role.iscoGroupLabel ? sentence(role.iscoGroupLabel) : CLOSENESS_LABEL[band]}
          </p>
          <p className="mt-1.5 text-[13px] text-ink-soft tabular-nums">
            {role.have} of {plural(role.total, "essential skill")} already
          </p>
        </div>
      </div>

      {role.missing.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
            Still to learn
          </p>
          <SkillPillList skills={role.missing} tone="gap" max={4} total={role.gap} />
        </div>
      )}
    </Link>
  );
}

/** The ring, inlined at card size — see `CoverageRing` for why a ring at all. */
function MiniRing({ coverage }: { coverage: number }) {
  const size = 56;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = { strong: "text-have", fair: "text-accent", distant: "text-gap" }[closeness(coverage)];

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox={`0 0 ${size} ${size}`} className={`size-full -rotate-90 ${tone}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * Math.max(0, Math.min(1, coverage))} ${circumference}`}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[13px] font-semibold tabular-nums ${tone}`}>
        {Math.round(coverage * 100)}%
      </span>
    </div>
  );
}
