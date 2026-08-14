/**
 * Loading states shaped like the answer, not spinners.
 *
 * This matters more here than in most apps. `/api/analyze` takes about seven
 * seconds against the c0 instance and no amount of concurrency fixes it
 * (PLAN.md §13), so whatever goes on screen in the meantime is a substantial
 * part of the experience rather than a flicker. A spinner for seven seconds
 * reads as a hang. A page that already has its headings, its three sections and
 * the right number of card-shaped holes reads as work in progress — and when
 * the content lands, nothing moves.
 *
 * The counts below are drawn from the real defaults: one hero, up to three
 * runners-up, twenty-four ranked roles (six shown as placeholders), six themes.
 */
function Line({ w, h = 12 }: { w: string; h?: number }) {
  return <div className="skeleton" style={{ width: w, height: h }} />;
}

function Pill({ w }: { w: string }) {
  return <div className="skeleton rounded-full" style={{ width: w, height: 26 }} />;
}

export function BridgeSkeleton() {
  return (
    <div className="rounded-2xl border border-accent-line bg-accent-soft p-6 sm:p-8">
      <Line w="8rem" h={11} />
      <div className="mt-4 space-y-2.5">
        <Line w="min(90%, 28rem)" h={26} />
        <Line w="min(70%, 20rem)" h={26} />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Pill w="9rem" />
        <Pill w="11rem" />
        <Pill w="7rem" />
      </div>
      <div className="mt-6 grid gap-3 border-t border-accent-line pt-5 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Line w="80%" />
            <Line w="45%" h={10} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RoleCardSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="flex items-start gap-4">
        <div className="skeleton size-14 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Line w="70%" h={15} />
          <Line w="45%" h={11} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Pill w="8rem" />
        <Pill w="6rem" />
        <Pill w="9rem" />
      </div>
    </div>
  );
}

function SectionSkeleton({ cards }: { cards: number }) {
  return (
    <section className="mt-12">
      <Line w="12rem" h={16} />
      <div className="mt-1.5">
        <Line w="20rem" h={11} />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {Array.from({ length: cards }, (_, i) => (
          <RoleCardSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

export function AnalysisSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Searching the graph for the roles closest to your skills…</span>
      <BridgeSkeleton />
      <SectionSkeleton cards={2} />
      <SectionSkeleton cards={4} />
      <section className="mt-12">
        <Line w="14rem" h={16} />
        <div className="mt-5 space-y-3.5">
          {["78%", "54%", "40%", "22%"].map((w) => (
            <div key={w} className="space-y-1.5">
              <Line w="9rem" h={11} />
              <div className="skeleton h-2 rounded-full" style={{ width: w }} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * The path is its own boundary on the detail page: Q6 answers in ~0.9s and Q5
 * takes 4–8s, so the occupation renders immediately and only the route waits.
 */
export function PathSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="rounded-xl border border-line bg-surface p-6">
      <span className="sr-only">Working out the cheapest route between these two jobs…</span>
      <Line w="16rem" h={15} />
      <div className="mt-6 space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-start gap-4">
            <div className="skeleton size-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Line w="55%" h={14} />
              <div className="flex gap-1.5">
                <Pill w="7rem" />
                <Pill w="9rem" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-8">
      <div className="flex items-start gap-5">
        <div className="skeleton size-20 shrink-0 rounded-full" />
        <div className="flex-1 space-y-3">
          <Line w="min(60%, 22rem)" h={28} />
          <Line w="40%" h={12} />
        </div>
      </div>
      <div className="space-y-2">
        <Line w="100%" h={12} />
        <Line w="92%" h={12} />
        <Line w="60%" h={12} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {["7rem", "9rem", "6rem", "11rem", "8rem", "7.5rem", "10rem"].map((w, i) => (
          <Pill key={i} w={w} />
        ))}
      </div>
    </div>
  );
}
