import { sentence } from "@/lib/format";

/**
 * One skill, rendered the same way everywhere it appears.
 *
 * `have` and `gap` are the app's two load-bearing colours, and this is the
 * component that spends them. A pill is never coloured for emphasis — green
 * means *you hold this skill* and amber means *you do not*, on every screen.
 */
export type PillTone = "have" | "gap" | "neutral" | "accent";

const TONES: Record<PillTone, string> = {
  have: "border-have-line bg-have-soft text-have",
  gap: "border-gap-line bg-gap-soft text-gap",
  neutral: "border-line bg-sunk text-ink-soft",
  accent: "border-accent-line bg-accent-soft text-accent",
};

export function SkillPill({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: PillTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] leading-5 ${TONES[tone]}`}
    >
      {tone === "have" && (
        <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0" fill="none">
          <path
            d="M2.5 6.4 L4.8 8.6 L9.5 3.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {tone === "gap" && (
        <svg viewBox="0 0 12 12" aria-hidden className="size-3 shrink-0" fill="none">
          <path d="M6 2.6 V9.4 M2.6 6 H9.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
      <span className="truncate">{sentence(label)}</span>
    </span>
  );
}

/**
 * The list of gaps, plus an honest "and N more".
 *
 * `rankRoles` caps `missing` at whatever the query returned, but a role can
 * still be missing thirty skills and printing all of them buries the card. The
 * overflow count is computed from `gap` — the real total — rather than from the
 * length of the list we happen to be showing.
 */
export function SkillPillList({
  skills,
  tone,
  max = 6,
  total,
}: {
  skills: readonly { uri: string; label: string }[];
  tone: PillTone;
  max?: number;
  total?: number;
}) {
  const shown = skills.slice(0, max);
  const hidden = (total ?? skills.length) - shown.length;

  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((skill) => (
        <SkillPill key={skill.uri} label={skill.label} tone={tone} />
      ))}
      {hidden > 0 && (
        <span className="inline-flex items-center px-1.5 py-1 text-[13px] leading-5 text-ink-muted">
          +{hidden} more
        </span>
      )}
    </div>
  );
}
