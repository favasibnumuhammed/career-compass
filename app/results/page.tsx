import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BridgeCard } from "@/components/BridgeCard";
import { EmptyState } from "@/components/EmptyState";
import { ErrorPanel } from "@/components/ErrorPanel";
import { RoleCard } from "@/components/RoleCard";
import { AnalysisSkeleton } from "@/components/Skeletons";
import { ThemeBars } from "@/components/ThemeBars";
import { WITHIN_REACH, analyse } from "@/lib/analysis";
import { percent, plural, sentence } from "@/lib/format";
import { load } from "@/lib/load";
import { FROM_PARAM, SKILLS_PARAM, contextQuery, readFrom, readSkills } from "@/lib/params";
import { occupationRefs } from "@/lib/queries";

export const metadata: Metadata = { title: "Your results" };

/**
 * The results.
 *
 * **The whole page is designed around seven seconds.** `analyse()` is ~7.5s
 * against the c0 instance and concurrency buys about 15% (PLAN.md §13), so the
 * shell — heading, skill count, edit link — renders immediately and the answer
 * streams into a Suspense boundary underneath it. That is the difference
 * between a page that is loading and a page that is broken.
 *
 * One boundary, not four. The tiers, the hero and the rollup come from one
 * `analyse()` call and land together, because they are one thought: *here is
 * where you stand, and here is the single thing to learn next.* Streaming them
 * separately would make the page rearrange itself three times over seven
 * seconds, which is worse than waiting.
 *
 * Order on the page is deliberate. The hero comes first because it is the
 * answer to the question the user actually has; the ranked roles are the
 * evidence for it. Putting the evidence first would bury the answer under
 * twenty-four cards.
 */
export default async function ResultsPage({ searchParams }: PageProps<"/results">) {
  const params = await searchParams;
  const skills = readSkills(params[SKILLS_PARAM]);
  const from = readFrom(params[FROM_PARAM]);

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pt-10 sm:pt-14">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink sm:text-[34px]">
            Where you stand
          </h1>
          <p className="mt-1.5 text-[15px] text-ink-soft">
            {skills.length > 0
              ? `Measured against every occupation in ESCO, from ${plural(skills.length, "skill")}.`
              : "No skills to measure yet."}
          </p>
        </div>
        {/* Back to the editor with the same set loaded, so "edit" means edit
            rather than start again. */}
        <Link
          href={`/${contextQuery(skills, from)}`}
          className="inline-flex h-9 items-center rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
        >
          Edit your skills
        </Link>
      </div>

      <div className="mt-8 pb-4">
        {skills.length === 0 ? (
          <EmptyState
            title="Pick at least two skills"
            action={
              <Link
                href="/"
                className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-accent-ink"
              >
                Choose skills
              </Link>
            }
          >
            This link carries no skills we recognise. Start from a job you&apos;ve done and we&apos;ll
            fill them in, or build the list yourself.
          </EmptyState>
        ) : (
          <Suspense key={skills.join(",")} fallback={<AnalysisSkeleton />}>
            <Analysis skills={skills} from={from} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

async function Analysis({ skills, from }: { skills: string[]; from: string | null }) {
  const result = await load("results", async () => {
    // The starting job's label is a cheap lookup and rides along with the
    // expensive work rather than delaying the shell by a second on its own.
    const [analysis, refs] = await Promise.all([
      analyse(skills, { exclude: from ? [from] : [] }),
      from ? occupationRefs([from]) : Promise.resolve(new Map<string, string>()),
    ]);
    return { analysis, fromLabel: from ? (refs.get(from) ?? null) : null };
  });

  if (!result.ok) return <ErrorPanel error={result.error} home />;

  const { analysis, fromLabel } = result.data;
  const { closest, withinReach, bridges, themes, meta } = analysis;

  if (closest.length === 0) {
    return (
      <EmptyState
        title="No occupation in ESCO requires any of these skills"
        action={
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-accent-ink"
          >
            Add more skills
          </Link>
        }
      >
        That usually means the list is very short, or every skill on it is one ESCO files as
        optional rather than essential. Adding two or three broader skills — the everyday ones you
        might not think to mention — normally fixes it.
      </EmptyState>
    );
  }

  const best = closest[0];

  return (
    <div className="space-y-12">
      {fromLabel && (
        <p className="-mb-6 text-[13px] text-ink-muted">
          Starting from <span className="text-ink-soft">{sentence(fromLabel)}</span>, which is left
          out of the results below.
        </p>
      )}

      <BridgeCard result={bridges} />

      <Section
        title="Within reach"
        blurb={`Roles where you already hold at least ${percent(WITHIN_REACH)} of the essential skills.`}
      >
        {withinReach.length > 0 ? (
          <Grid>
            {withinReach.map((role) => (
              <RoleCard key={role.uri} role={role} skills={skills} from={from} />
            ))}
          </Grid>
        ) : (
          <EmptyState title="Nothing clears halfway yet — and that is normal">
            Your closest role is {sentence(best.label)} at {percent(best.coverage)}. ESCO gives every
            occupation a distinctive essential-skill set, so a single job&apos;s skills rarely cover
            half of another. The roles below are still the right ones to aim at, and the skill at the
            top of this page is the fastest way to move the number.
          </EmptyState>
        )}
      </Section>

      <Section
        title="Closest roles"
        blurb={`The ${closest.length} occupations you cover most of, best first. Open one to see exactly what is missing — and how to get there.`}
      >
        <Grid>
          {closest.map((role) => (
            <RoleCard key={role.uri} role={role} skills={skills} from={from} />
          ))}
        </Grid>
      </Section>

      <Section
        title="Where your gaps cluster"
        blurb={`The ${plural(meta.gaps, "distinct skill")} separating you from those roles, grouped by ESCO theme.`}
      >
        <ThemeBars themes={themes} gaps={meta.gaps} />
      </Section>
    </div>
  );
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">{blurb}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}
