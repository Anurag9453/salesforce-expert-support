import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS } from "@sfx/domain";
import { AuthForm } from "@/components/auth/auth-form";
import { serverEnv } from "@/lib/env";
import { safeInternalPath } from "@/lib/safe-path";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const redirectTo = safeInternalPath(next, "/dashboard");
  if ((await getActor()) !== ANONYMOUS) redirect(redirectTo);
  const env = serverEnv();
  const signInHref =
    redirectTo === "/hire"
      ? "/hire/start"
      : `/login${next ? `?next=${encodeURIComponent(redirectTo)}` : ""}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink">
          Create an account
        </h1>
        {/* One account covers both sides — requirement 1, said plainly. */}
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
          One account for getting help and, if you choose, for giving it.
        </p>
      </div>

      <AuthForm
        mode="register"
        googleEnabled={Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)}
        redirectTo={redirectTo}
        awaitVerification={env.MAILER_PROVIDER !== "mock"}
      />

      <p className="text-sm text-ink-muted">
        Already have an account?{" "}
        <Link href={signInHref} className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
