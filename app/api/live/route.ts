import { NextResponse } from "next/server";

/** Never cached: a stale 200 from a CDN would defeat the point. */
export const dynamic = "force-dynamic";

/**
 * Process liveness, deliberately independent of the database.
 *
 * This is the hosting platform's health check, and it is a different question
 * from `/api/health`. A failing platform check makes the platform restart the
 * container — which cannot fix a CognoDB outage, and would take down the very
 * outage panel built to explain one. So the platform is asked "is this server
 * answering HTTP?", and the database's state is reported by `/api/health`,
 * where the UI's retry button consumes it.
 *
 * It touches no module that reads the environment, so it also answers 200 on a
 * deploy that is missing its credentials — which is the state in which the
 * `misconfigured` message from `/api/health` most needs to be reachable.
 */
export function GET() {
  return NextResponse.json({ status: "ok", uptime: Math.round(process.uptime()) });
}
