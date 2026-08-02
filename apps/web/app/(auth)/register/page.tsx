import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS } from "@sfx/domain";
import { AuthForm } from "@/components/auth/auth-form";
import { serverEnv } from "@/lib/env";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if ((await getActor()) !== ANONYMOUS) redirect("/dashboard");
  const env = serverEnv();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Create an account</h1>
        {/* One account covers both sides — requirement 1, said plainly. */}
        <p className="mt-1 text-sm text-ink-muted">
          One account for getting help and, if you choose, for giving it.
        </p>
      </div>

      <AuthForm
        mode="register"
        googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)}
        redirectTo="/dashboard"
      />

      <p className="text-sm text-ink-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
