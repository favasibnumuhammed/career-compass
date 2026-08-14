import { z } from "zod";

/**
 * Connection configuration, read from the environment and validated once.
 *
 * Validation is lazy (on first `getEnv()` call) rather than at module load so
 * that `next build` — which imports server modules without any database being
 * reachable or configured — does not fail on a machine that has no `.env`.
 * Anything that actually talks to CognoDB calls `getEnv()` and gets a loud,
 * specific error at that point instead.
 */
const envSchema = z.object({
  COGNODB_URI: z
    .string()
    .min(1, "COGNODB_URI is required")
    .refine(
      (uri) => /^(bolt|bolt\+s|bolt\+ssc|neo4j|neo4j\+s|neo4j\+ssc):\/\//.test(uri),
      "COGNODB_URI must be a Bolt URI, e.g. bolt+s://<instance-id>.databases.cognodb.com",
    ),
  COGNODB_USER: z.string().min(1, "COGNODB_USER is required").default("cognodb"),
  COGNODB_PASSWORD: z.string().min(1, "COGNODB_PASSWORD is required"),
  COGNODB_DATABASE: z.string().min(1).optional(),
  COGNODB_MAX_POOL_SIZE: z.coerce.number().int().positive().max(200).default(20),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export class EnvError extends Error {
  readonly name = "EnvError";
}

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse({
    COGNODB_URI: process.env.COGNODB_URI,
    COGNODB_USER: process.env.COGNODB_USER,
    COGNODB_PASSWORD: process.env.COGNODB_PASSWORD,
    COGNODB_DATABASE: process.env.COGNODB_DATABASE,
    COGNODB_MAX_POOL_SIZE: process.env.COGNODB_MAX_POOL_SIZE,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new EnvError(
      `Invalid CognoDB configuration.\n${details}\n\nCopy .env.example to .env and fill in your instance details.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test seam: forget the cached config so a later `getEnv()` re-reads process.env. */
export function resetEnvCache(): void {
  cached = null;
}
