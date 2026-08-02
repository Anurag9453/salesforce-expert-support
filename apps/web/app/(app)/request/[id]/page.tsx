import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDomainError } from "@sfx/domain";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { RequestStatus } from "@/components/request/request-status";
import { getContainer } from "@/lib/container";
import { toRequestView } from "@/lib/request-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Your request" };
export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const { supportRequests, attachments, pricing } = getContainer();

  let view;
  try {
    // Throws FORBIDDEN for anyone but the owner. A guessed id renders nothing.
    const record = await supportRequests.getForCustomer(actor, id);
    const tier = await pricing.findTierById(record.pricingTierId);
    view = toRequestView(record, await attachments.listForRequest(id), tier?.durationMinutes ?? 30);
  } catch (error) {
    if (isDomainError(error) && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/dashboard" className="text-xs text-ink-muted hover:text-ink">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">{view.title}</h1>
        <p className="mt-1 text-xs text-ink-subtle">
          Raised {new Date(view.createdAt).toLocaleString()} ·{" "}
          {formatPrice(view.price.amountMinor, view.price.currency)} for{" "}
          {view.price.durationMinutes} minutes
        </p>
      </div>

      <RequestStatus initial={view} />

      <Card>
        <CardHeader>
          <CardTitle>What you told us</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{view.description}</p>

          {view.attachments.length > 0 && (
            <div className="border-t border-border pt-3.5">
              <p className="mb-2 text-xs font-medium text-ink-subtle">Attachments</p>
              <ul className="space-y-1.5">
                {view.attachments.map((attachment) => (
                  <li key={attachment.id} className="flex items-center gap-2 text-xs">
                    <span className="text-ink">{attachment.filename}</span>
                    <Badge>{Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB</Badge>
                    <span className="text-ink-subtle">
                      visible only to you and your matched expert
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
