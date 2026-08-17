import { existsSync } from "node:fs";
import type { HealthResponse } from "@sfx/contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/lib/container";
import { serverEnv } from "@/lib/env";
import { collectRuntimeDiagnostics, runtimeDiagnosticsEnabled } from "@/lib/runtime-diagnostics";

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

  /*
    Is the CA certificate actually present in this runtime?

    Needed because nothing else notices when it is not. Prisma ignores
    `sslrootcert` entirely — it connects the same whether the file exists or was
    never deployed — so the database check above passes regardless. Only `pg`
    reads it, and the one thing using `pg` here is the realtime LISTEN, which
    connects lazily when the first subscriber appears. Without this, a certificate
    missing from the bundle stays invisible until an expert opens a stream and
    realtime quietly fails.

    Reports booleans, not paths. The resolved path and working directory go to
    the server log, where an operator can see them and a stranger cannot.
  */
  const caPath = /[?&]sslrootcert=([^&]+)/.exec(serverEnv().DIRECT_DATABASE_URL ?? "")?.[1];
  if (caPath) {
    const resolved = decodeURIComponent(caPath);
    const present = existsSync(resolved);
    checks.tls = {
      // `ok` deliberately: a configured certificate that is absent is a
      // misconfiguration, and a deployment should be able to fail on it.
      ok: present,
      detail: present ? "CA certificate present" : "CA certificate configured but missing",
    };
    if (!present) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "CA certificate not found at the configured path",
          path: resolved,
          cwd: process.cwd(),
        }),
      );
    }
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
    // Read-only, preview and local only. Temporary — see runtime-diagnostics.ts.
    ...(runtimeDiagnosticsEnabled() ? { diagnostics: collectRuntimeDiagnostics() } : {}),
  };

  return NextResponse.json(body, { status: healthy ? 200 : 503 });
}
