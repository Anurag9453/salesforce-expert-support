import type { RateLimiter, RateLimitDecision, RateLimitRule } from "@sfx/domain";

/**
 * Fixed-window rate limiter held in process memory.
 *
 * ⚠️ **Not suitable for public deployment.** It is per-process: with N instances
 * an attacker gets N× the limit, and a deploy resets every counter. It exists so
 * limits are wired at the right call sites now, rather than retrofitted later —
 * which is when the one unprotected route gets missed.
 *
 * Swapping in a shared store (Redis/Upstash) is the deploy-blocking task
 * recorded in ARCHITECTURE.md → Pre-deployment gates.
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly name = "in-memory";

  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = Date.now();
    this.sweep(now);

    const bucketKey = `${rule.name}:${key}`;
    const windowMs = rule.windowSeconds * 1000;
    const existing = this.windows.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      this.windows.set(bucketKey, { count: 1, resetAt });
      return {
        allowed: true,
        limit: rule.limit,
        remaining: rule.limit - 1,
        resetAt: new Date(resetAt),
      };
    }

    // Counted even when rejected, so hammering the endpoint cannot shorten the
    // window by racing the reset.
    existing.count += 1;
    const allowed = existing.count <= rule.limit;

    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - existing.count),
      resetAt: new Date(existing.resetAt),
    };
  }

  /** Periodic eviction so a long-lived process does not grow unbounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  /** Test helper. */
  reset(): void {
    this.windows.clear();
    this.lastSweep = 0;
  }
}
