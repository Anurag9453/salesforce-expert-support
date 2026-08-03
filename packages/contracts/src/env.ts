import { z } from "zod";

/**
 * Environment contract (§30 — secrets via environment, never in the bundle).
 *
 * Validated at boot. A missing or malformed variable fails immediately with a
 * readable message, rather than surfacing as a null-pointer at 3am.
 *
 * Variables are tagged by the phase that makes them mandatory. Everything a
 * later phase needs is `.optional()` today, so Phase 1 boots without a payment
 * provider, a video provider, or an AI key.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: "must be a postgres:// or postgresql:// connection string",
  });

/** Both-or-neither: a half-configured OAuth provider fails at the login screen. */
function pairedCredentials<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  a: keyof T & string,
  b: keyof T & string,
  label: string,
) {
  return schema.superRefine((value, ctx) => {
    const record = value as Record<string, unknown>;
    const hasA = Boolean(record[a]);
    const hasB = Boolean(record[b]);
    if (hasA !== hasB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasA ? b : a],
        message: `${label} requires both ${a} and ${b}, or neither.`,
      });
    }
  });
}

const baseServerEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ── Phase 1: required ─────────────────────────────────────────────────────
  DATABASE_URL: postgresUrl,
  /** Unpooled connection. Prisma Migrate cannot run through PgBouncer. */
  DIRECT_DATABASE_URL: postgresUrl.optional(),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "must be at least 32 characters — generate with `openssl rand -base64 32`"),
  BETTER_AUTH_URL: z.string().url(),

  // ── Phase 2: Google sign-in ───────────────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

  // ── Phase 3: attachments (S3-compatible; Cloudflare R2) ───────────────────
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_REGION: z.string().min(1).default("auto"),
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  // ── Phase 3: problem classification (§C1) ─────────────────────────────────
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * Model is configuration, not code, so the promotion evaluation can run a
   * comparative sample without a code change.
   */
  CLASSIFIER_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  /** `mock` keeps Phases 1–5 free of an API key. */
  CLASSIFIER_PROVIDER: z.enum(["anthropic", "mock"]).default("mock"),

  // ── Phase 4: expert presence (§C4) ────────────────────────────────────────
  /** How often the expert client pings. Served to the client, not hard-coded there. */
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(45),
  /**
   * How long presence survives without a ping.
   *
   * Configurable mainly so the sweep can be demonstrated in seconds rather than
   * minutes during a walkthrough. The 180s default is chosen against browser
   * background-tab throttling — see DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS.
   */
  HEARTBEAT_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(180),

  // ── Phase 5: matching (§15) ───────────────────────────────────────────────
  /**
   * How long an expert has to answer an offer.
   *
   * 60 seconds is the product decision (§Q6). Configurable so the timeout path
   * can be demonstrated and tested in seconds rather than minutes — the stored
   * `offerExpiresAt` means shortening it cannot corrupt an offer already open.
   */
  OFFER_WINDOW_SECONDS: z.coerce.number().int().positive().max(600).default(60),

  // ── Phase 6: realtime ─────────────────────────────────────────────────────
  ABLY_API_KEY: z.string().min(1).optional(),
  REALTIME_PROVIDER: z.enum(["ably", "mock"]).default("mock"),

  // ── Phase 7a/7b: payments & payouts — provider undecided (Q3) ─────────────
  PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  PAYOUT_PROVIDER: z.enum(["mock"]).default("mock"),

  // ── Phase 8: video ────────────────────────────────────────────────────────
  DAILY_API_KEY: z.string().min(1).optional(),
  VIDEO_PROVIDER: z.enum(["daily", "mock"]).default("mock"),

  // ── Email ─────────────────────────────────────────────────────────────────
  RESEND_API_KEY: z.string().min(1).optional(),
  MAILER_PROVIDER: z.enum(["resend", "mock"]).default("mock"),
  MAIL_FROM: z.string().email().default("noreply@example.com"),

  // ── Observability ─────────────────────────────────────────────────────────
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const serverEnvSchema = pairedCredentials(
  baseServerEnv,
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "Google sign-in",
).superRefine((value, ctx) => {
  // A ping slower than the timeout sweeps everyone who is genuinely present.
  // Cheap to get wrong by editing one of the two, so it is checked at boot.
  if (value.HEARTBEAT_INTERVAL_SECONDS >= value.HEARTBEAT_STALE_AFTER_SECONDS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["HEARTBEAT_INTERVAL_SECONDS"],
      message:
        "must be shorter than HEARTBEAT_STALE_AFTER_SECONDS, or every present expert is swept offline.",
    });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Anything here is inlined into the client bundle. Never put a secret in it (§30). */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const detail = issues
      .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    super(`Invalid environment configuration:\n${detail}\n`);
    this.name = "EnvValidationError";
  }
}

export function parseServerEnv(raw: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return result.data;
}

export function parseClientEnv(raw: Record<string, string | undefined>): ClientEnv {
  const result = clientEnvSchema.safeParse(raw);
  if (!result.success) throw new EnvValidationError(result.error.issues);
  return result.data;
}
