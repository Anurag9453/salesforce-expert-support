/**
 * Rate limiting (§30).
 *
 * **This port must be backed by a shared store before public deployment.**
 * The in-memory implementation is per-process: with more than one instance
 * serving traffic, an attacker gets N× the limit, and a deploy resets every
 * counter. It is correct for local development and single-instance staging only.
 * See ARCHITECTURE.md → "Pre-deployment gates".
 *
 * The port exists from Phase 3 so limits are applied at the call sites that need
 * them — authentication and request submission — rather than retrofitted across
 * the codebase later, which is when the one unprotected route gets missed.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** When the window resets. Sent as `Retry-After` on a rejection. */
  readonly resetAt: Date;
}

export interface RateLimitRule {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimiter {
  readonly name: string;
  /**
   * `key` must identify the subject, not the action — typically `user:<id>` or
   * `ip:<addr>`. The rule supplies the action's own budget.
   */
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/**
 * Named budgets, in one place so they can be reviewed as a set.
 *
 * Deliberately generous: the goal is to stop scripted abuse, not to inconvenience
 * a customer who mistypes a password twice or resubmits a request after fixing a
 * validation error.
 */
export const RATE_LIMITS = {
  /** Sign-in and sign-up, per IP. Credential stuffing is the threat. */
  AUTH: { name: "auth", limit: 10, windowSeconds: 60 },
  /** Creating support requests, per user. Each one authorizes a payment. */
  REQUEST_CREATE: { name: "request_create", limit: 5, windowSeconds: 300 },
  /** Presigning uploads, per user. */
  ATTACHMENT_UPLOAD: { name: "attachment_upload", limit: 20, windowSeconds: 300 },
  /** Everything else authenticated, per user. A backstop, not a real defence. */
  GENERAL: { name: "general", limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;
