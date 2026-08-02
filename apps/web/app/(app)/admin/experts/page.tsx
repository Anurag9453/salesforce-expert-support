import type { ExpertStatus } from "@sfx/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@sfx/domain";
import { Badge, Card, CardBody, CardHeader, CardTitle, ExpertStatusBadge } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Expert applications" };
export const dynamic = "force-dynamic";

const FILTERS: Array<{ label: string; statuses: ExpertStatus[] | null }> = [
  { label: "Needs review", statuses: null },
  { label: "Approved", statuses: ["APPROVED"] },
  { label: "Rejected", statuses: ["REJECTED"] },
  { label: "Suspended", statuses: ["SUSPENDED"] },
  { label: "Draft", statuses: ["DRAFT"] },
];

export default async function AdminExpertsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const actor = await requireActor();
  // Server-side gate. The nav link is hidden for non-admins, but hiding a link
  // is not authorization — this redirect is (requirement 4).
  if (!can(actor, "admin:read_experts")) redirect("/dashboard");

  const params = await searchParams;
  const selected = params.status ? (params.status.split(",") as ExpertStatus[]) : null;

  const { expertAdmin } = getContainer();
  const page = selected
    ? await expertAdmin.listByStatus(actor, selected)
    : await expertAdmin.listPendingReview(actor);
  const items = page.items.map(toExpertApplicationView);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Expert applications</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Oldest submission first — whoever has waited longest is reviewed first.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Filter by status">
        {FILTERS.map((filter) => {
          const href = filter.statuses
            ? `/admin/experts?status=${filter.statuses.join(",")}`
            : "/admin/experts";
          const isActive = filter.statuses
            ? params.status === filter.statuses.join(",")
            : !params.status;
          return (
            <Link
              key={filter.label}
              href={href}
              className={
                isActive
                  ? "rounded-sm border border-accent/25 bg-accent-subtle px-2.5 py-1 text-xs font-medium text-accent"
                  : "rounded-sm border border-border px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-sunken"
              }
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {items.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-ink-muted">Nothing here.</p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {items.length} application{items.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/admin/experts/${item.id}`}
                    className="flex flex-wrap items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-sunken"
                  >
                    <ExpertStatusBadge status={item.status} />
                    <span className="text-sm text-ink">
                      {item.country ?? "—"} · {item.yearsExperience ?? 0} yrs
                    </span>
                    <span className="truncate text-xs text-ink-subtle">
                      {item.professionalSummary?.slice(0, 80) ?? "No summary yet"}
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-xs text-ink-subtle">
                      {item.eligibleForMatching && <Badge tone="available">eligible</Badge>}
                      {item.submittedAt
                        ? new Date(item.submittedAt).toLocaleDateString()
                        : "not submitted"}
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
