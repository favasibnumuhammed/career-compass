import { DetailSkeleton } from "@/components/Skeletons";

/**
 * Q6 takes ~0.9s, which is short enough to be tempting to ignore and long
 * enough to look like a dead link on a slow connection. The page's own skeleton
 * costs nothing and keeps the header, the ring and the skill tray in place
 * while it resolves.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-5 pt-10 sm:pt-14">
      <DetailSkeleton />
    </div>
  );
}
