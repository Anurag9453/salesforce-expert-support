"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/format";

/**
 * The customer pays, and their meeting link appears.
 *
 * Shown only in PAYMENT_PENDING, which is reached the moment the chosen expert
 * confirms. The urgency is real and worth conveying: an expert has committed
 * their time and is waiting on this screen being dealt with.
 *
 * No card fields, on purpose. The payment provider is still undecided, and a
 * realistic-looking card form would be a form that collects real card numbers
 * and sends them nowhere — the one thing this screen must never be. It arrives
 * with the provider; the flow around it is already correct.
 */
export function PayPanel({
  supportRequestId,
  amountCents,
  currency,
  durationMinutes,
  expertName,
}: {
  supportRequestId: string;
  amountCents: number;
  currency: string;
  durationMinutes: number;
  expertName: string | null;
}) {
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setPaying(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/requests/${supportRequestId}/pay`, { method: "POST" });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      // The server has moved the request to READY; re-render so the room takes
      // this card's place.
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPaying(false);
    }
  }

  return (
    <Card accent className="animate-scale-in">
      <CardBody className="space-y-4 p-6">
        <Badge tone="accent" pulse>
          {expertName ? `${expertName} confirmed` : "Your expert confirmed"}
        </Badge>

        <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-border pb-4">
          <span className="text-sm text-ink-muted">{durationMinutes}-minute session</span>
          <span data-numeric className="font-display text-3xl font-medium text-ink">
            {formatMoney(amountCents, currency)}
          </span>
        </div>

        <p className="text-sm leading-relaxed text-ink-muted">
          Pay to get your meeting link. Your expert is holding this time for you.
        </p>

        {error && <Alert tone="danger">{error}</Alert>}

        <Button size="lg" className="w-full" disabled={paying} onClick={() => void pay()}>
          {paying ? "Taking payment…" : `Pay ${formatMoney(amountCents, currency)}`}
        </Button>

        <p className="text-xs leading-relaxed text-ink-subtle">
          This build uses a test payment gateway — no card is collected and nothing is charged.
        </p>
      </CardBody>
    </Card>
  );
}
