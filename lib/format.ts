/**
 * Wording, in one place.
 *
 * Most of this is small, and it is here rather than inline because the same
 * numbers appear on three screens and a percentage that rounds differently in
 * two places looks like a bug.
 */

/** `0.457` → `"46%"`. Never rounds a real gap up to 100% or down to 0%. */
export function percent(value: number): string {
  const scaled = value * 100;
  if (scaled > 0 && scaled < 1) return "<1%";
  if (scaled < 100 && scaled > 99) return "99%";
  return `${Math.round(scaled)}%`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How close is close?
 *
 * The bands are set from the real distribution rather than from round numbers.
 * On ESCO data a typical user's best match sits at 40–50% and almost nothing
 * clears 70% (PLAN.md §11), so a scale that reserves its top band for 90% would
 * render every result in the same colour and say nothing.
 */
export type Closeness = "strong" | "fair" | "distant";

export function closeness(coverage: number): Closeness {
  if (coverage >= 0.6) return "strong";
  if (coverage >= 0.35) return "fair";
  return "distant";
}

export const CLOSENESS_LABEL: Record<Closeness, string> = {
  strong: "Well within reach",
  fair: "A realistic move",
  distant: "A longer road",
};

/** Sentence-case a label that ESCO ships lower-cased. */
export function sentence(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** `["a", "b", "c"]` → `"a, b and c"`. */
export function list(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * ESCO's `reuseLevel`, said in English.
 *
 * Present for only 1,171 of 13,201 skills (PLAN.md §10), so every caller has to
 * handle its absence — hence `null` rather than a fallback string.
 */
export function reuseLevel(value: string | undefined): string | null {
  switch (value) {
    case "transversal":
      return "Applies across every sector";
    case "cross-sector":
      return "Applies across several sectors";
    case "sector-specific":
      return "Specific to this sector";
    case "occupation-specific":
      return "Specific to this occupation";
    default:
      return null;
  }
}
