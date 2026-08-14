import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CoverageRing } from "@/components/CoverageRing";
import { ErrorPanel } from "@/components/ErrorPanel";
import { PathChain } from "@/components/PathChain";
import { PathSkeleton } from "@/components/Skeletons";
import { SkillPill } from "@/components/SkillPill";
import { escoId, occupationUri } from "@/lib/esco";
import { percent, plural, sentence } from "@/lib/format";
import { NOT_FOUND, load, loadOne } from "@/lib/load";
import { FROM_PARAM, SKILLS_PARAM, contextQuery, occupationHref, readFrom, readSkills } from "@/lib/params";
import { careerPath, occupationDetail, occupationRefs } from "@/lib/queries";
import type { DetailSkill } from "@/lib/types";

/**
 * One occupation, measured against the visitor.
 *
 * **Two Suspense boundaries, because the two halves cost an order of magnitude
 * apart.** Q6 answers in ~0.9s; Q5 takes 4.0s direct and 7.7s through the
 * meet-in-the-middle fallback (PLAN.md §12). Waiting for the route before
 * showing the job would triple the time to first useful pixel for a section
 * many visitors never scroll to — so the occupation renders as soon as it is
 * ready and the career path streams in underneath it.
 *
 * The `?s=` skill set is what turns this from a reference page into an answer:
 * with it, every skill is marked have or missing and the ring is a number.
 * Without it the ring is an em-dash rather than 0%, because "we don't know" and
 * "you have none of these" are different things (`OccupationDetail.coverage`).
 */
export async function generateMetadata({ params }: PageProps<"/occupation/[id]">): Promise<Metadata> {
  const { id } = await params;
  const uri = occupationUri(id);
  if (!uri) return { title: "Unknown occupation" };

  // A cheap indexed lookup, and a failure here must not take the page with it —
  // a shared link with a dead database should still render its error panel.
  const refs = await load("occupation:metadata", () => occupationRefs([uri]));
  const label = refs.ok ? refs.data.get(uri) : undefined;
  return { title: label ? sentence(label) : "Occupation" };
}

export default async function OccupationPage({
  params,
  searchParams,
}: PageProps<"/occupation/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const uri = occupationUri(id);
  const skills = readSkills(query[SKILLS_PARAM]);
  const from = readFrom(query[FROM_PARAM]);

  // **Why this is not `notFound()`.** It ought to be — an occupation we do not
  // have deserves a real 404 status, not a 200 with an apology on it. Measured
  // against Next 16.3.0, neither arrangement of `notFound()` works here:
  //
  //   with a sibling loading.tsx     200, and the 404 copy never reaches the
  //                                  HTML at all — payload only, client-rendered
  //   without one                    404, but a completely blank body: no
  //                                  layout, no content, nothing without JS
  //
  // A page that renders nothing is a worse failure than a wrong status, and
  // "we don't have that" versus "we can't reach the database" is a distinction
  // the plan grades on what the *reader* sees (§5). So the page renders the
  // panel itself, server-side, and the machine-readable 404 stays where it is
  // actually consumed: `GET /api/occupation/<unknown>` still answers 404, and
  // `npm run api` still checks that it does.
  if (!uri) {
    return (
      <Shell>
        <ErrorPanel error={NOT_FOUND} home />
      </Shell>
    );
  }

  const result = await loadOne("occupation", () => occupationDetail(uri, skills));
  if (!result.ok) {
    return (
      <Shell>
        <ErrorPanel error={result.error} home />
      </Shell>
    );
  }

  const detail = result.data;
  const held = detail.essential.filter((skill) => skill.have);
  const missing = detail.essential.filter((skill) => !skill.have);

  return (
    <Shell>
      {skills.length > 0 && (
        <Link
          href={`/results${contextQuery(skills, from)}`}
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-ink"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" fill="none">
            <path d="M13 8H4m0 0 3.2-3.2M4 8l3.2 3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to your results
        </Link>
      )}

      <header className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-4 sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[38px]">
            {sentence(detail.label)}
          </h1>
          <p className="mt-2 text-[13px] text-ink-muted">
            {[detail.iscoGroupLabel && sentence(detail.iscoGroupLabel), detail.iscoCode && `ISCO ${detail.iscoCode}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <CoverageRing coverage={detail.coverage} size={76} label={detail.label} />
          <p className="max-w-40 text-[13px] leading-snug text-ink-muted">
            {detail.coverage === null
              ? "Add your skills to see how close you are."
              : `of the ${plural(detail.essential.length, "essential skill")} covered`}
          </p>
        </div>
      </header>

      {detail.description && (
        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-ink-soft">
          {detail.description}
        </p>
      )}

      {detail.altLabels.length > 0 && (
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-ink-muted">
          Also advertised as {detail.altLabels.slice(0, 6).map(sentence).join(", ")}.
        </p>
      )}

      {/* The essential list, split rather than annotated. A single list with
          ticks makes you read all forty items to find the gap; two lists make
          "what is missing" the shape of the section. */}
      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight text-ink">Essential skills</h2>
        <p className="mt-1 text-[13px] text-ink-muted">
          ESCO&apos;s own flag, not a threshold we chose. {detail.essential.length} in total.
        </p>

        <div className="mt-5 grid gap-6 md:grid-cols-2">
          <SkillColumn
            title={detail.coverage === null ? "What it needs" : `You already have ${held.length}`}
            skills={detail.coverage === null ? detail.essential : held}
            tone={detail.coverage === null ? "neutral" : "have"}
            empty="None of these yet — this is a longer road than the roles on your results page."
          />
          {detail.coverage !== null && (
            <SkillColumn
              title={`Still to learn — ${missing.length}`}
              skills={missing}
              tone="gap"
              empty="Nothing. You hold every essential skill for this job."
            />
          )}
        </div>
      </section>

      {detail.optional.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Often asked for</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            {plural(detail.optional.length, "skill")} ESCO marks optional for this job — useful, but
            not what you are measured on above.
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {detail.optional.map((skill) => (
              <SkillPill
                key={skill.uri}
                label={skill.label}
                tone={skill.have ? "have" : "neutral"}
              />
            ))}
          </div>
        </section>
      )}

      {from && from !== uri && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Getting here from where you are</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            The cheapest route through jobs that actually exist, over a similarity network derived
            from shared essential skills.
          </p>
          <div className="mt-5">
            <Suspense fallback={<PathSkeleton />}>
              <Path from={from} to={uri} skills={skills} />
            </Suspense>
          </div>
        </section>
      )}

      {detail.neighbours.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Jobs most like this one</h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            Ranked by how much of their essential-skill sets overlap.
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {detail.neighbours.map((neighbour) => (
              <li key={neighbour.uri}>
                <Link
                  href={occupationHref(neighbour.uri, skills, from)}
                  className="flex items-baseline justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-2.5 transition-colors hover:border-line-strong hover:bg-sunk"
                >
                  <span className="min-w-0 truncate text-sm text-ink">{sentence(neighbour.label)}</span>
                  <span className="shrink-0 text-[13px] tabular-nums text-ink-muted">
                    {percent(neighbour.jaccard)} alike
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-12 text-[13px] text-ink-muted">
        ESCO concept:{" "}
        <a
          href={detail.uri}
          className="font-mono text-[12px] underline underline-offset-2 hover:text-accent"
          target="_blank"
          rel="noreferrer"
        >
          {escoId(detail.uri)}
        </a>
      </p>
    </Shell>
  );
}

async function Path({ from, to, skills }: { from: string; to: string; skills: string[] }) {
  const result = await load("occupation:path", async () => {
    const [refs, path] = await Promise.all([
      occupationRefs([from, to]),
      careerPath(from, to, { skills }),
    ]);
    return { refs, path };
  });

  if (!result.ok) return <ErrorPanel error={result.error} />;

  const { refs, path } = result.data;
  const fromLabel = refs.get(from);
  const toLabel = refs.get(to);

  // The starting job came from a URL that may be stale. Saying so beats
  // rendering "no route exists", which would blame the careers for a bad link.
  if (!fromLabel || !toLabel) {
    return <ErrorPanel error={{ ...NOT_FOUND, message: "We don't have the job you started from." }} />;
  }

  return (
    <PathChain
      result={{ from: { uri: from, label: fromLabel }, to: { uri: to, label: toLabel }, path }}
      skills={skills}
    />
  );
}

function SkillColumn({
  title,
  skills,
  tone,
  empty,
}: {
  title: string;
  skills: readonly DetailSkill[];
  tone: "have" | "gap" | "neutral";
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {title}
      </h3>
      {skills.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skills.map((skill) => (
            <SkillPill key={skill.uri} label={skill.label} tone={tone} />
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-4xl px-5 pt-10 sm:pt-14">{children}</div>;
}
