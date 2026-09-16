"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Sign-in and registration share a form because they differ by one field.
 *
 * Google is always offered on this form. If Google OAuth is not configured,
 * the button stays visible and explains why it cannot complete — hiding it
 * made the freelancer login look like email-only.
 */
export function AuthForm({
  mode,
  googleEnabled,
  redirectTo,
  awaitVerification = false,
}: {
  mode: "login" | "register";
  googleEnabled: boolean;
  redirectTo: string;
  /** After signup, show "check your email" instead of sending them into the app unsigned-in. */
  awaitVerification?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

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

    if (isRegister && awaitVerification) {
      setRegistered(true);
      setPending(false);
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  function onGoogle() {
    if (!googleEnabled) {
      setError(
        "Google sign-in is not configured yet. Use email and password, or add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.",
      );
      return;
    }
    setError(null);
    setPending(true);
    void signIn.social({ provider: "google", callbackURL: redirectTo });
  }

  if (registered) {
    return (
      <Alert tone="success">
        Account created. Check your email for a confirmation link, then sign in.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}

      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        loading={pending}
        disabled={pending}
        onClick={onGoogle}
      >
        <GoogleMark />
        Continue with Google
      </Button>

      <div className="flex items-center gap-3 text-xs text-ink-subtle">
        <span className="h-px flex-1 bg-border" />
        or continue with email
        <span className="h-px flex-1 bg-border" />
      </div>

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
          {pending ? "Working…" : isRegister ? "Create account" : "Sign in with email"}
        </Button>
      </form>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.4-1.1 2.6-2.4 3.4v2.8h3.8c2.3-2.1 3.6-5.2 3.6-8.3z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1 7.9-2.8l-3.8-2.8c-1.1.7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3c2 4 6.1 6.4 10.7 6.4z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.6c-.2-.7-.4-1.4-.4-2.6s.1-1.9.4-2.6V6.4H1.3C.5 8.1 0 10 0 12s.5 3.9 1.3 5.6l4-3z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.4 0 3.3 2.4 1.3 6.4l4 3c.9-2.9 3.6-4.6 6.7-4.6z"
      />
    </svg>
  );
}
