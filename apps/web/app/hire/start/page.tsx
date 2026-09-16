import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS } from "@sfx/domain";
import { AuthForm } from "@/components/auth/auth-form";
import { LandingHeader } from "@/components/landing/landing-header";
import { buttonClasses } from "@/components/ui";
import { serverEnv } from "@/lib/env";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Log in to hire talent" };
export const dynamic = "force-dynamic";

const HIRE = "/hire";

export default async function HireStartPage() {
  if ((await getActor()) !== ANONYMOUS) redirect(HIRE);
  const env = serverEnv();

  return (
    <div className="min-h-dvh overflow-x-clip">
      <LandingHeader simple />
      <div className="mx-auto w-full max-w-md px-6 py-12">
        <div className="space-y-6">
          <div>
            <h1 className="font-display text-2xl font-medium tracking-tight text-ink">
              Log in to continue
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
              See previous sessions, experts you&rsquo;ve worked with, and more.
            </p>
            <Link
              href={HIRE}
              className={buttonClasses({ variant: "secondary", size: "md", className: "mt-4" })}
            >
              Skip for now
            </Link>
          </div>

          <AuthForm
            mode="login"
            googleEnabled={Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)}
            redirectTo={HIRE}
          />

          <p className="text-sm text-ink-muted">
            New here?{" "}
            <Link href={`/register?next=${encodeURIComponent(HIRE)}`} className="font-medium text-accent hover:underline">
              Create an account
            </Link>
            {" · "}
            <Link href={HIRE} className="font-medium text-accent hover:underline">
              Skip for now
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
