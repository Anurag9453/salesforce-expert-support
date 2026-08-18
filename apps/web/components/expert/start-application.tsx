"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@/components/ui";

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
      <PageHeader
        title="Become an expert"
        description="Paid Salesforce support, matched to your actual strengths."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>What happens next</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {/* Numbered in display type, so the sequence reads as a path rather than a list. */}
          <ol className="stagger space-y-3">
            {[
              "Tell us about your Salesforce experience.",
              "Submit for review — a human reads every application.",
              "Once approved, you can go available and receive requests.",
            ].map((step, index) => (
              <li key={step} className="flex gap-3 text-sm text-ink-muted">
                <span
                  data-numeric
                  className="font-display shrink-0 text-base leading-tight font-medium text-accent/60"
                >
                  {index + 1}.
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
          <Alert tone="info">
            This uses the account you are signed in with. You keep your customer access, and you can
            request help yourself at any time.
          </Alert>
          <Button onClick={() => void start()} loading={pending} disabled={pending} size="lg">
            {pending ? "Starting…" : "Start my application"}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
