import neo4j, {
  type Driver,
  type QueryConfig,
  type Record as Neo4jRecord,
  type RecordShape,
} from "neo4j-driver";
import { EnvError, getEnv } from "./env";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** The database could not be reached: DNS, TLS, timeout, or instance asleep. */
export class DbUnreachableError extends Error {
  readonly name = "DbUnreachableError";
  constructor(cause?: unknown) {
    super("Cannot reach the graph database.");
    this.cause = cause;
  }
}

/** Credentials were rejected. Distinct from unreachable — the fix is different. */
export class DbAuthError extends Error {
  readonly name = "DbAuthError";
  constructor(cause?: unknown) {
    super("CognoDB rejected the supplied credentials.");
    this.cause = cause;
  }
}

/** The connection is fine; this particular Cypher statement failed. */
export class DbQueryError extends Error {
  readonly name = "DbQueryError";
  constructor(
    message: string,
    readonly code: string | undefined,
    cause?: unknown,
  ) {
    super(message);
    this.cause = cause;
  }
}

const UNREACHABLE_CODES = new Set(["ServiceUnavailable", "SessionExpired"]);
const UNREACHABLE_SYSCALLS = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EPIPE/;
const AUTH_CODES = new Set([
  "Neo.ClientError.Security.Unauthorized",
  "Neo.ClientError.Security.AuthenticationRateLimit",
]);

/**
 * Translate a driver error into one of our three cases. The API layer maps
 * these onto status codes so the UI can tell "we can't reach the database"
 * apart from "that query was wrong" — two very different messages for a user.
 */
export function classifyDbError(error: unknown): Error {
  if (
    error instanceof DbUnreachableError ||
    error instanceof DbAuthError ||
    error instanceof DbQueryError
  ) {
    return error;
  }

  // A missing or invalid configuration is not a database error and must not be
  // dressed up as one. `verifyConnection` reaches `getEnv()` from inside its
  // try block, so without this an unconfigured server tells /api/health
  // "unexpected database error" — sending whoever is debugging it to look at
  // the database instead of at their environment.
  if (error instanceof EnvError) return error;

  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code && AUTH_CODES.has(code)) return new DbAuthError(error);
  if (code && UNREACHABLE_CODES.has(code)) return new DbUnreachableError(error);
  if (code && code.startsWith("Neo.TransientError")) return new DbUnreachableError(error);
  if (UNREACHABLE_SYSCALLS.test(message)) return new DbUnreachableError(error);
  if (/routing|connection acquisition timed out|failed to connect/i.test(message)) {
    return new DbUnreachableError(error);
  }

  return new DbQueryError(message, code, error);
}

/* -------------------------------------------------------------------------- */
/* Driver singleton                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One Driver per process, reused across every request.
 *
 * The driver owns an internal connection pool, so creating one per request
 * would burn through the free tier's 200-connection cap almost immediately.
 * Stashing it on globalThis keeps it alive across Next's dev-mode hot reloads,
 * which otherwise re-evaluate this module on every edit and leak a pool a time.
 */
const globalForDriver = globalThis as unknown as { __cognodbDriver?: Driver };

export function getDriver(): Driver {
  if (globalForDriver.__cognodbDriver) return globalForDriver.__cognodbDriver;

  const env = getEnv();
  const driver = neo4j.driver(
    env.COGNODB_URI,
    neo4j.auth.basic(env.COGNODB_USER, env.COGNODB_PASSWORD),
    {
      maxConnectionPoolSize: env.COGNODB_MAX_POOL_SIZE,
      connectionAcquisitionTimeout: 10_000,
      connectionTimeout: 10_000,
      maxTransactionRetryTime: 8_000,
      // The c0 instance is small; keeping idle sockets around buys nothing.
      maxConnectionLifetime: 5 * 60_000,
      disableLosslessIntegers: false,
    },
  );

  globalForDriver.__cognodbDriver = driver;
  return driver;
}

export async function closeDriver(): Promise<void> {
  const driver = globalForDriver.__cognodbDriver;
  if (!driver) return;
  globalForDriver.__cognodbDriver = undefined;
  await driver.close();
}

/** Cheap liveness check used by /api/health and by the UI's retry button. */
export async function verifyConnection(): Promise<{ ok: true; address?: string }> {
  try {
    const info = await getDriver().getServerInfo({ database: getEnv().COGNODB_DATABASE });
    return { ok: true, address: info.address };
  } catch (error) {
    throw classifyDbError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Query execution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Neo4j returns 64-bit integers as `Integer` objects, which do not survive
 * `JSON.stringify` in any form a React component can render. Normalise them —
 * and anything nested inside lists/maps — into plain JS values on the way out.
 */
function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (neo4j.isInt(value)) {
    return value.inSafeRange() ? value.toNumber() : value.toString();
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    // Only walk plain maps; leave temporal/spatial driver types alone.
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)]),
      );
    }
  }
  return value;
}

type Params = Record<string, unknown>;

async function run<T>(query: string, params: Params, routing: "READ" | "WRITE"): Promise<T[]> {
  const env = getEnv();
  const config: QueryConfig<RecordShape> = {
    database: env.COGNODB_DATABASE,
    routing: routing === "READ" ? neo4j.routing.READ : neo4j.routing.WRITE,
  };

  try {
    const { records } = await getDriver().executeQuery(query, params, config);
    return records.map((record: Neo4jRecord) => toPlain(record.toObject()) as T);
  } catch (error) {
    throw classifyDbError(error);
  }
}

/**
 * Run a read query.
 *
 * `params` is always a real Bolt parameter map — every value the user supplies
 * reaches the database as a parameter, never as text spliced into the Cypher.
 * That is both the injection boundary and how the server gets to reuse a
 * query plan across calls.
 */
export function runRead<T = Record<string, unknown>>(query: string, params: Params = {}) {
  return run<T>(query, params, "READ");
}

/** Run a write query (schema setup and seeding; the app itself never writes). */
export function runWrite<T = Record<string, unknown>>(query: string, params: Params = {}) {
  return run<T>(query, params, "WRITE");
}
