import { NextResponse } from "next/server";
import { DbAuthError, DbUnreachableError, verifyConnection } from "@/lib/db";
import { EnvError } from "@/lib/env";

/** Never cached: the point of this route is to report live database state. */
export const dynamic = "force-dynamic";

/**
 * Readiness probe for the CognoDB connection.
 *
 * Consumed by the UI's "try again" button on the database-unreachable panel.
 * The three failure shapes are kept distinct because they need three different
 * messages: misconfiguration, bad credentials, and an instance that is down or
 * asleep.
 *
 * Not the hosting platform's health check — that is `/api/live`, which asks
 * whether this process is answering HTTP. See the comment there for why the
 * two must not be the same route.
 */
export async function GET() {
  try {
    const info = await verifyConnection();
    return NextResponse.json({ status: "ok", address: info.address });
  } catch (error) {
    if (error instanceof EnvError) {
      return NextResponse.json(
        { status: "misconfigured", message: "Database connection is not configured." },
        { status: 500 },
      );
    }
    if (error instanceof DbAuthError) {
      return NextResponse.json(
        { status: "unauthorized", message: "Database rejected the configured credentials." },
        { status: 500 },
      );
    }
    if (error instanceof DbUnreachableError) {
      return NextResponse.json(
        { status: "unreachable", message: "Cannot reach the graph database right now." },
        { status: 503 },
      );
    }
    return NextResponse.json({ status: "error", message: "Unexpected database error." }, { status: 500 });
  }
}
