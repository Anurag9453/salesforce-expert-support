import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS } from "@sfx/domain";
import { AuthForm } from "@/components/auth/auth-form";
import { serverEnv } from "@/lib/env";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if ((await getActor()) !== ANONYMOUS) redirect("/dashboard");
  const env = serverEnv();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-medium tracking-tight text-ink">Sign in</h1>
        <p className="mt-1.5 text-sm text-ink-muted">Welcome back.</p>
      </div>

      <AuthForm
        mode="login"
        googleEnabled={Boolean(env.GOOGLE_CLIENT_ID)}
        redirectTo="/dashboard"
      />

      <p className="text-sm text-ink-muted">
        No account?{" "}
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}
