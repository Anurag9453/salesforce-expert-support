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

  /**
   * When each relaxation level becomes available, in seconds from submission.
   *
   * Four ascending values, comma-separated. The default — `0,90,180,360` — is
   * tuned for a small launch roster: a thin bench runs out of level-0 candidates
   * in seconds, and making the customer wait four minutes for a level change
   * they cannot see is the worst possible use of a fifteen-minute promise.
   *
   * Tuning this changes how *soon* the search widens, never how *far*. The
   * primary-skill floor is enforced separately and cannot be configured at all.
   */
  RELAXATION_SCHEDULE_SECONDS: z
    .string()
    .default("0,90,180,360")
    .transform((value, ctx) => {
      const parts = value.split(",").map((part) => Number(part.trim()));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "must be four non-negative seconds, comma-separated, e.g. 0,90,180,360",
        });
        return z.NEVER;
      }
      if (parts[0] !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "level 0 must engage immediately, so the first value must be 0",
        });
        return z.NEVER;
      }
      for (let i = 1; i < parts.length; i++) {
        if ((parts[i] ?? 0) <= (parts[i - 1] ?? 0)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "values must strictly ascend — a later level cannot engage earlier",
          });
          return z.NEVER;
        }
      }
      return parts as [number, number, number, number];
    }),

  // ── Phase 6: realtime ─────────────────────────────────────────────────────
  ABLY_API_KEY: z.string().min(1).optional(),
  /**
   * `postgres` — LISTEN/NOTIFY over the connection we already hold. No signup, no
   * API key, no second failure domain. Needs a process that can keep a long-lived
   * connection open, which rules out a purely serverless web tier.
   *
   * `mock` — delivers nothing. Not a stub: a runnable demonstration that dispatch
   * does not depend on delivery (requirement 10).
   *
   * `ably` — reserved. The `RealtimeBus` port exists so this is a composition-root
   * change, but there is no adapter yet and shipping an untested one would be
   * worse than shipping none.
   */
  REALTIME_PROVIDER: z.enum(["postgres", "ably", "mock"]).default("postgres"),

  /**
   * How a request reaches an expert.
   *
   * `exclusive` — the original loop: the best-ranked expert holds a 60-second
   * offer, and a decline moves to the next. The platform picks.
   *
   * `interest_pool` — broadcast to the top N, collect raised hands, show the
   * customer the best three, and the one they pick confirms within two minutes.
   *
   * Both are implemented and both are legal in the state machine. Defaulting to
   * `exclusive` keeps the existing regression suites meaningful; flipping the
   * default is a one-line change once the new flow has been exercised.
   */
  DISPATCH_MODE: z.enum(["exclusive", "interest_pool"]).default("exclusive"),
  /** How many experts a broadcast reaches. Beyond this, ranking has decided. */
  INTEREST_BROADCAST_SIZE: z.coerce.number().int().min(1).max(50).default(8),
  /** How long to collect raised hands before showing the customer a shortlist. */
  INTEREST_WINDOW_SECONDS: z.coerce.number().int().min(10).max(600).default(90),

  // ── Payments ──────────────────────────────────────────────────────────────
  /**
   * `stripe` requires both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
   *
   * The webhook secret is not optional-when-convenient: without it a webhook
   * cannot be verified, and an unverified webhook means anyone who finds the
   * endpoint can announce a payment that never happened. The refinement below
   * makes that a boot failure rather than a runtime discovery.
   */
  PAYMENT_PROVIDER: z.enum(["stripe", "mock"]).default("mock"),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
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
  // The last relaxation level has to be reachable inside the matching window,
  // or the ladder has a rung nothing ever stands on.
  //
  // Defensive read. When the inner transform rejects the value Zod still runs
  // this refinement, and the field holds Zod's INVALID sentinel rather than an
  // array — so an unguarded `.at()` throws a TypeError and the caller gets that
  // instead of the readable EnvValidationError listing what was actually wrong.
  const schedule: unknown = value.RELAXATION_SCHEDULE_SECONDS;
  const lastLevelAt = Array.isArray(schedule) ? (schedule.at(-1) as number) : 0;
  if (lastLevelAt >= 15 * 60) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["RELAXATION_SCHEDULE_SECONDS"],
      message:
        "the last level must engage well inside the 15-minute matching window, or it is unreachable.",
    });
  }
  /*
    Selecting Stripe without its credentials must fail at boot, not at the first
    customer. Missing the webhook secret is the dangerous half: the app would run,
    take authorizations, and then be unable to verify a single confirmation —
    which looks like working software right up until reconciliation.
  */
  if (value.PAYMENT_PROVIDER === "stripe") {
    if (!value.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STRIPE_SECRET_KEY"],
        message: "is required when PAYMENT_PROVIDER=stripe.",
      });
    }
    if (!value.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STRIPE_WEBHOOK_SECRET"],
        message:
          "is required when PAYMENT_PROVIDER=stripe — without it no webhook can be verified, and an unverified webhook is anyone announcing a payment that never happened.",
      });
    }
  }

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
