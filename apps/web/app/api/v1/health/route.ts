import type { HealthResponse } from "@sfx/contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/lib/container";

export const dynamic = "force-dynamic";

/**
 * Liveness + dependency check. Used by the deploy platform, by CI to confirm
 * the app actually boots, and by `pnpm verify`.
 *
 * Reports `degraded` with a 503 rather than throwing, so a load balancer can
 * make a routing decision instead of receiving a stack trace.
 */
export async function GET(): Promise<NextResponse> {
  const checks: HealthResponse["checks"] = {};

  try {
    const { prisma } = getContainer();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (error) {
    checks.database = {
      ok: false,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }

  try {
    const { paymentGateway, payoutProvider } = getContainer();
    // Surfaces which providers are actually wired — during Phases 1–6 both
    // should read "mock", and seeing that in staging is the point (§C2).
    checks.providers = {
      ok: true,
      detail: `payment=${paymentGateway.name} payout=${payoutProvider.name}`,
    };
  } catch (error) {
    checks.providers = {
      ok: false,
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }

  const healthy = Object.values(checks).every((check) => check.ok);
  const body: HealthResponse = {
    status: healthy ? "ok" : "degraded",
    version: process.env.npm_package_version ?? "0.1.0",
    checks,
  };

  return NextResponse.json(body, { status: healthy ? 200 : 503 });
}
