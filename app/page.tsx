import { SkillBuilder } from "@/components/SkillBuilder";
import { ErrorPanel } from "@/components/ErrorPanel";
import { load } from "@/lib/load";
import { FROM_PARAM, SKILLS_PARAM, readFrom, readSkills } from "@/lib/params";
import { occupationRefs, skillRefs } from "@/lib/queries";
import type { SkillRef } from "@/lib/types";

/**
 * The entry screen.
 *
 * Normally there is nothing to load — the builder is a client component and
 * the two doors are static. The exception is arriving *back* here from the
 * results with `?s=…` in the URL, which is how "edit your skills" works: the
 * ids have to be turned back into labelled chips before the editor can render
 * them, so the page resolves them on the server and hands them down.
 *
 * That round trip is the price of keeping the skill set in the URL rather than
 * in a store, and it buys refreshable, shareable, back-button-correct links on
 * every screen (`lib/params.ts`).
 */
export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const skillUris = readSkills(params[SKILLS_PARAM]);
  const fromUri = readFrom(params[FROM_PARAM]);

  let skills: SkillRef[] = [];
  let from: { uri: string; label: string } | null = null;

  if (skillUris.length > 0 || fromUri) {
    const resolved = await load("entry", async () => {
      const [refs, occupations] = await Promise.all([
        skillRefs(skillUris),
        fromUri ? occupationRefs([fromUri]) : Promise.resolve(new Map<string, string>()),
      ]);
      const label = fromUri ? occupations.get(fromUri) : undefined;
      return { refs, from: label ? { uri: fromUri!, label } : null };
    });

    // The panel replaces the builder rather than sitting above it. If this
    // lookup failed the database is unreachable, and an editor whose typeahead
    // fails on every keystroke is a worse place to be stranded than a panel
    // with a working retry on it.
    if (!resolved.ok) {
      return (
        <Shell>
          <div className="mt-10">
            <ErrorPanel error={resolved.error} />
          </div>
        </Shell>
      );
    }
    skills = resolved.data.refs;
    from = resolved.data.from;
  }

  return (
    <Shell>
      <div className="mt-10">
        <SkillBuilder initialSkills={skills} initialFrom={from} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-14 sm:pt-20">
      <h1 className="text-[32px] font-semibold leading-[1.15] tracking-tight text-ink sm:text-[42px]">
        Which single skill
        <br className="hidden sm:block" /> unlocks the most doors?
      </h1>
      <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-soft">
        Every careers site tells you which jobs match what you already have. Compass tells you the
        one thing to learn next — and the cheapest route to where you&apos;re going.
      </p>
      {children}
      <p className="mt-8 text-[13px] leading-relaxed text-ink-muted">
        Built on 2,909 occupations and 13,201 skills from ESCO, plus a similarity network derived
        between them. Nothing you type is stored.
      </p>
    </div>
  );
}
