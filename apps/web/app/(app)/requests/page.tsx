import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardBody, buttonClasses } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Your requests" };
export const dynamic = "force-dynamic";

const TONE: Record<string, "neutral" | "accent" | "available" | "warning" | "danger"> = {
  CREATED: "accent",
  CLASSIFYING: "accent",
  SEARCHING: "accent",
  OFFERED: "accent",
  ACCEPTED: "available",
  READY: "available",
  IN_SESSION: "available",
  COMPLETED: "neutral",
  CANCELLED: "warning",
  NO_EXPERT_FOUND: "warning",
  REFUNDED: "warning",
  DISPUTED: "danger",
};

export default async function RequestsPage() {
  const actor = await requireActor();
  const page = await getContainer().supportRequests.listForCustomer(actor, { limit: 25 });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Your requests</h1>
        <Link href="/request-help" className={buttonClasses({ size: "sm" })}>
          Get Expert Help
        </Link>
      </header>

      {page.items.length === 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-muted">You haven&rsquo;t raised a request yet.</p>
            <Link
              href="/request-help"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Describe a problem
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {page.items.map((request) => (
                <li key={request.id}>
                  <Link
                    href={`/request/${request.id}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-sunken"
                  >
                    <Badge tone={TONE[request.state] ?? "neutral"}>
                      {request.state.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                    <span className="truncate text-sm text-ink">{request.title}</span>
                    <span className="ml-auto text-xs text-ink-subtle">
                      {request.createdAt.toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
