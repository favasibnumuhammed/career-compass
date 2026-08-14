"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * The last resort.
 *
 * Almost nothing should reach here: database failures are returned as values
 * and rendered by `ErrorPanel` with their real message, precisely because
 * React replaces a Server Component error's message with a digest in
 * production and the plan's database-unreachable panel would degrade to
 * "something went wrong" (see `lib/load.ts`). What is left for this boundary is
 * an actual bug — a render that threw — and for that, "something went wrong" is
 * the honest thing to say.
 *
 * Next 16 names the recovery prop `retry`, not `reset`.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled render error:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-20">
      <div className="rounded-xl border border-danger-line bg-danger-soft p-6">
        <h1 className="text-lg font-semibold text-ink">Something went wrong on this page</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
          This one is on us, not on your skills or your link. Trying again sometimes clears it; if
          it doesn&apos;t, start over and the app will rebuild the page from scratch.
        </p>
        {error.digest && (
          <p className="mt-3 font-mono text-[12px] text-ink-muted">reference {error.digest}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={retry}
            className="inline-flex h-9 items-center rounded-lg bg-ink px-4 text-[13px] font-medium text-page transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Start over
          </Link>
        </div>
      </div>
    </div>
  );
}
