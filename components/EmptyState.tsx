/**
 * "There is nothing here, and that is an answer."
 *
 * Distinct from `ErrorPanel` on purpose. An empty tier is not a failure — on
 * real ESCO data, tier 2 is empty for most people, because nothing clears 50%
 * coverage from a single job's skill set (PLAN.md §11/§12). Rendering that as a
 * warning would teach the user to distrust a correct result.
 *
 * The rule every use follows: say what is missing, say *why*, and offer the one
 * action that would change it.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-sunk px-6 py-8 text-center">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      <div className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-muted">{children}</div>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
