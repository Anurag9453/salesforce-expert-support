"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign-in and registration share a form because they differ by one field.
 *
 * Google sign-in appears only when the server says it is configured — a button
 * that leads to a provider error is worse than no button.
 */
export function AuthForm({
  mode,
  googleEnabled,
  redirectTo,
}: {
  mode: "login" | "register";
  googleEnabled: boolean;
  redirectTo: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === "register";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();

    const result = isRegister
      ? await signUp.email({ email, password, name })
      : await signIn.email({ email, password });

    if (result.error) {
      setError(result.error.message ?? "Could not complete that. Please try again.");
      setPending(false);
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {isRegister && (
          <Field id="name" label="Full name" required>
            <Input id="name" name="name" autoComplete="name" required minLength={2} />
          </Field>
        )}

        <Field id="email" label="Work email" required>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>

        <Field
          id="password"
          label="Password"
          required
          {...(isRegister ? { hint: "At least 12 characters." } : {})}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
            minLength={isRegister ? 12 : undefined}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={pending} disabled={pending}>
          {pending ? "Working…" : isRegister ? "Create account" : "Sign in"}
        </Button>
      </form>

      {googleEnabled && (
        <>
          <div className="flex items-center gap-3 text-xs text-ink-subtle">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            loading={pending}
            disabled={pending}
            onClick={() => void signIn.social({ provider: "google", callbackURL: redirectTo })}
          >
            Continue with Google
          </Button>
        </>
      )}
    </div>
  );
}
