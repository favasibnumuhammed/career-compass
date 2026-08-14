import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-20">
      <p className="font-mono text-[13px] text-ink-muted">404</p>
      <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink">
        There&apos;s no page here
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
        Compass has three screens: the skill editor, your results, and a page per occupation. This
        URL is none of them.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex h-10 items-center rounded-lg bg-accent px-5 text-[15px] font-medium text-accent-ink transition-opacity hover:opacity-90"
      >
        Start from a job you&apos;ve done
      </Link>
    </div>
  );
}
