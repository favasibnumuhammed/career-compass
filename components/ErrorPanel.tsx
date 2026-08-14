"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { LoadFailure } from "@/lib/load";

/**
 * The screen that says *why* nothing is here.
 *
 * PLAN.md §5 asks for a database-unreachable panel "visually distinct from 'no
 * results'", and that distinction is the whole point of the component: a person
 * who is told "no matches" edits their skills, and a person who is told "the
 * database is down" waits. Getting those two the wrong way round wastes the
 * user's time in a way they cannot diagnose.
 *
 * So the panels differ in colour, in wording, and in what they offer — only the
 * outage panel gets a retry button, because only an outage is the sort of thing
 * that fixes itself.
 *
 * The retry pings `/api/health` before reloading anything. Re-rendering a page
 * whose data is still unreachable just replays the seven-second failure and
 * shows the same panel again, which looks like the button is broken. A
 * sub-second liveness check first means the button can say "still down" and
 * leave the user where they are.
 */
type HealthState = "idle" | "checking" | "down" | "recovering";

export function ErrorPanel({ error, home = false }: { error: LoadFailure; home?: boolean }) {
  const outage = error.code === "db_unreachable";
  return outage ? <OutagePanel message={error.message} /> : <PlainPanel error={error} home={home} />;
}

function OutagePanel({ message }: { message: string }) {
  const router = useRouter();
  const [state, setState] = useState<HealthState>("idle");
  const [, startTransition] = useTransition();

  async function retry() {
    setState("checking");
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) {
        setState("down");
        return;
      }
      // The database answered. Re-render the route on the server; the panel
      // stays put with a "reconnected" label until the new content replaces it.
      setState("recovering");
      startTransition(() => router.refresh());
    } catch {
      setState("down");
    }
  }

  return (
    // The heading deliberately does not repeat the message underneath it —
    // `classifyError` already opens with "Can't reach the graph database", and
    // the two stacked read as a stutter.
    <Panel tone="danger" icon={<PlugIcon />} title="The database isn't answering">
      <p>{message}</p>
      <p className="mt-2 text-ink-muted">
        This is an outage, not an empty result — your skills are fine and the link you followed is
        fine. The instance is a free-tier database and may be waking up.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={retry}
          disabled={state === "checking" || state === "recovering"}
          className="inline-flex h-9 items-center rounded-lg bg-ink px-4 text-[13px] font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {state === "checking" ? "Checking…" : state === "recovering" ? "Reconnected — reloading…" : "Try again"}
        </button>
        <span aria-live="polite" className="text-[13px] text-ink-muted">
          {state === "down" && "Still unreachable. Give it another few seconds."}
        </span>
      </div>
    </Panel>
  );
}

function PlainPanel({ error, home }: { error: LoadFailure; home: boolean }) {
  const missing = error.code === "not_found";
  return (
    <Panel
      tone="neutral"
      icon={missing ? <QuestionIcon /> : <AlertIcon />}
      title={missing ? "We don't have that one" : "Something went wrong"}
    >
      <p>{error.message}</p>
      {missing && (
        <>
          <p className="mt-2 text-ink-muted">
            Compass knows the 2,909 occupations ESCO publishes and nothing else. The link may be
            mistyped, or it may point at a job ESCO files under a different name.
          </p>
          {/* The half of the distinction that is easy to leave implicit: without
              this line, "we don't have that" and "the database is down" look
              like the same shrug to someone who followed a broken link. */}
          <p className="mt-2 text-ink-muted">
            This is not a database problem — if the graph were unreachable you would be looking at a
            different screen, with a retry button on it.
          </p>
        </>
      )}
      {home && (
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-ink px-4 text-[13px] font-medium text-page transition-opacity hover:opacity-90"
        >
          Start over
        </Link>
      )}
    </Panel>
  );
}

function Panel({
  tone,
  icon,
  title,
  children,
}: {
  tone: "danger" | "neutral";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const skin =
    tone === "danger"
      ? "border-danger-line bg-danger-soft"
      : "border-line bg-surface";
  const iconSkin = tone === "danger" ? "text-danger" : "text-ink-muted";

  return (
    <div className={`rounded-xl border p-6 ${skin}`}>
      <div className="flex gap-4">
        <span className={`mt-0.5 shrink-0 ${iconSkin}`}>{icon}</span>
        <div className="min-w-0 text-[15px] leading-relaxed text-ink-soft">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <div className="mt-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6" fill="none" strokeWidth="1.6" stroke="currentColor">
      <path d="M9 3v5M15 3v5" strokeLinecap="round" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" strokeLinejoin="round" />
      <path d="M12 17v4" strokeLinecap="round" />
      <path d="M4 4l16 16" strokeLinecap="round" />
    </svg>
  );
}

function QuestionIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6" fill="none" strokeWidth="1.6" stroke="currentColor">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.6" strokeLinecap="round" />
      <path d="M12 16.6h.01" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6" fill="none" strokeWidth="1.6" stroke="currentColor">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.2" strokeLinecap="round" />
      <path d="M12 16.4h.01" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
