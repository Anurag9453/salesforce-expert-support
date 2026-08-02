import type { RateLimitRule } from "@sfx/domain";
import { NextResponse } from "next/server";
import { getContainer } from "./container.js";

/**
 * Applies a rate limit and returns a 429 when it is exceeded.
 *
 * ⚠️ Backed by an in-process limiter today. That is fine locally and wrong in
 * production — see ARCHITECTURE.md → Pre-deployment gates. The call sites are
 * here now so the swap is a one-line change in the container rather than an
 * audit of every route.
 */
export async function enforceRateLimit(
  key: string,
  rule: RateLimitRule,
): Promise<NextResponse | null> {
  const decision = await getContainer().rateLimiter.consume(key, rule);
  if (decision.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "RATE_LIMITED" as const,
        message: `Too many attempts. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfter),
        "x-ratelimit-limit": String(decision.limit),
        "x-ratelimit-remaining": String(decision.remaining),
      },
    },
  );
}

/**
 * Best-effort client address for unauthenticated limits.
 *
 * Trusts `x-forwarded-for` because Vercel sets it and strips inbound copies.
 * On a platform that does not, this is spoofable — which is one more reason the
 * shared-store swap is a deployment gate rather than a nice-to-have.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}
