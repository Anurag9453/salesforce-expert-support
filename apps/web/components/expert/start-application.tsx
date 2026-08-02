"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";

/**
 * Entry point into the expert side for an existing account.
 *
 * Requirement 1 made concrete: this adds the EXPERT role to the account you are
 * already signed in with. There is no second signup, and no separate identity.
 */
export function StartApplication() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/expert-application", { method: "POST" });
    const body = await response.json();
    if (!body.ok) {
      setError(body.error.message);
      setPending(false);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Become an expert</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Paid Salesforce support, matched to your actual strengths.
        </p>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>What happens next</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <ol className="space-y-2 text-sm text-ink-muted">
            <li>1. Tell us about your Salesforce experience.</li>
            <li>2. Submit for review — a human reads every application.</li>
            <li>3. Once approved, you can go available and receive requests.</li>
          </ol>
          <Alert tone="info">
            This uses the account you are signed in with. You keep your customer access, and you can
            request help yourself at any time.
          </Alert>
          <Button onClick={() => void start()} disabled={pending} size="lg">
            {pending ? "Starting…" : "Start my application"}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
