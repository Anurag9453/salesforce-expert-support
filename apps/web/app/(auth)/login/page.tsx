import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS } from "@sfx/domain";
import { AuthForm } from "@/components/auth/auth-form";
import { serverEnv } from "@/lib/env";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Freelancer login" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if ((await getActor()) !== ANONYMOUS) redirect("/dashboard");
  const env = serverEnv();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl font-medium tracking-tight text-ink">
          Login as Freelancer
        </h2>
        <p className="mt-1.5 text-sm text-ink-muted">
          Sign in with Google or email to take matched Salesforce work.
        </p>
      </div>

      <AuthForm
        mode="login"
        googleEnabled={Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)}
        redirectTo="/dashboard"
      />

      <p className="text-sm text-ink-muted">
        New freelancer?{" "}
        <Link href="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
        {" · "}
        <Link href="/expert-application" className="font-medium text-accent hover:underline">
          Apply as an expert
        </Link>
      </p>
    </div>
  );
}
