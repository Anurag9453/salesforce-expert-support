import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isDomainError } from "@sfx/domain";
import { Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@/components/ui";
import { toShortlistView } from "@/lib/matching-view";
import { CandidateCards } from "@/components/request/candidate-cards";
import { RequestStatus } from "@/components/request/request-status";
import { getContainer } from "@/lib/container";
import { loadMatchedExpert, toRequestView } from "@/lib/request-view";
import { requireActor } from "@/lib/session";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Your request" };
export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  const { supportRequests, attachments, pricing } = getContainer();

  let view;
  let record;
  let shortlist = null;
  try {
    // Throws FORBIDDEN for anyone but the owner. A guessed id renders nothing.
    record = await supportRequests.getForCustomer(actor, id);
    const tier = await pricing.findTierById(record.pricingTierId);
    view = toRequestView(
      record,
      await attachments.listForRequest(id),
      tier?.durationMinutes ?? 30,
      new Date(),
      await loadMatchedExpert(getContainer().prisma, record),
    );

    // Only while the customer actually has a decision to make. Any other state
    // renders the normal status panel.
    if (record.state === "SHORTLISTED" || record.state === "AWAITING_EXPERT_CONFIRMATION") {
      shortlist = await toShortlistView(record, getContainer());
    }
  } catch (error) {
    if (isDomainError(error) && (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        back={{ href: "/dashboard", label: "Dashboard" }}
        title={view.title}
        description={
          <span className="text-xs text-ink-subtle">
            Raised {new Date(view.createdAt).toLocaleString()} ·{" "}
            {formatMoney(view.price.amountMinor, view.price.currency)} for{" "}
            {view.price.durationMinutes} minutes
          </span>
        }
      />

      {/*
        The shortlist replaces the status panel while the customer is choosing —
        at that moment the decision is theirs, and a status line saying "finding
        an expert" alongside three cards would be contradictory.
      */}
      {shortlist ? (
        <CandidateCards supportRequestId={record.id} initial={shortlist} />
      ) : (
        <RequestStatus initial={view} />
      )}

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
