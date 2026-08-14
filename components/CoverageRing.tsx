import { closeness, percent } from "@/lib/format";

/**
 * Coverage as a ring: how much of a job's essential skill list you already hold.
 *
 * The ring is deliberately *not* a progress bar. A bar reads as "you are 46% of
 * the way to done", which would be a lie — the remaining 54% is a list of named
 * skills, not a countdown. A ring reads as a proportion of a whole, which is
 * exactly what `have / total` is.
 *
 * `coverage: null` is a real state and is drawn as an empty track with an
 * em-dash, never as 0%: on the detail page, "we don't know your skills" and
 * "you have none of these" are different answers and only one of them is bad
 * news (`OccupationDetail.coverage`, PLAN.md §6).
 */
const TONE = {
  strong: "text-have",
  fair: "text-accent",
  distant: "text-gap",
} as const;

export function CoverageRing({
  coverage,
  size = 56,
  label,
}: {
  coverage: number | null;
  size?: number;
  label?: string;
}) {
  const stroke = size >= 72 ? 6 : 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = coverage === null ? 0 : Math.max(0, Math.min(1, coverage));
  const tone = coverage === null ? "text-ink-muted" : TONE[closeness(coverage)];

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        coverage === null
          ? "Coverage unknown — no skills given"
          : `${percent(coverage)} of the essential skills${label ? ` for ${label}` : ""}`
      }
    >
      <svg viewBox={`0 0 ${size} ${size}`} className={`size-full -rotate-90 ${tone}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * filled} ${circumference}`}
          />
        )}
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center font-semibold tabular-nums ${tone}`}
        style={{ fontSize: size >= 72 ? 18 : 13 }}
      >
        {coverage === null ? "—" : percent(coverage)}
      </span>
    </div>
  );
}
