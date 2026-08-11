import { can } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "In-flight requests" };
export const dynamic = "force-dynamic";

/**
 * The in-flight queue (§C5).
 *
 * Deliberately not a dashboard. One table, sorted by whichever request is closest
 * to running out of time, showing the two things that decide whether to
 * intervene: how long is left, and how many experts have already passed.
 *
 * A request at relaxation 2 with three timeouts and four minutes left is one an
 * operator should look at. That should be visible without clicking anything.
 */
export default async function AdminRequestsPage() {
  const actor = await requireActor();
  if (!can(actor, "admin:read_requests")) redirect("/dashboard");

  const { prisma } = getContainer();
  const rows = await prisma.supportRequest.findMany({
    where: { state: { in: ["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED"] } },
    orderBy: { matchDeadlineAt: "asc" },
    take: 100,
    select: {
      id: true,
      title: true,
      state: true,
      matchDeadlineAt: true,
      customer: { select: { user: { select: { email: true } } } },
      matchingRuns: {
        orderBy: { roundNumber: "desc" },
        take: 1,
        select: { relaxationLevel: true },
      },
      matchingAttempts: { select: { status: true } },
    },
  });

  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="In-flight requests"
        description="Everything still being matched, soonest deadline first. Open one to see why each expert was or was not chosen, and to dispatch manually."
      />

      <Card>
        <CardHeader>
          <CardTitle>{rows.length} in flight</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-ink-muted">
              Nothing in flight. Quiet is the normal state.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-ink-subtle">
                    <th className="px-5 py-2.5 font-medium">Request</th>
                    <th className="py-2.5 pr-3 font-medium">State</th>
                    <th className="py-2.5 pr-3 font-medium">Relax</th>
                    <th className="py-2.5 pr-3 font-medium">Passed on</th>
                    <th className="py-2.5 pr-5 text-right font-medium">Time left</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => {
                    const secondsLeft = Math.max(
                      0,
                      Math.ceil((row.matchDeadlineAt.getTime() - now) / 1000),
                    );
                    const declined = row.matchingAttempts.filter(
                      (a) => a.status === "DECLINED",
                    ).length;
                    const timedOut = row.matchingAttempts.filter(
                      (a) => a.status === "TIMED_OUT",
                    ).length;
                    const passed = declined + timedOut;
                    // The two signals that mean "look at this one".
                    const urgent = secondsLeft < 5 * 60 || passed >= 3;

                    return (
                      <tr key={row.id} className={urgent ? "bg-warning-subtle" : undefined}>
                        <td className="px-5 py-3">
                          <Link
                            href={`/admin/requests/${row.id}`}
                            className="block max-w-[22rem] truncate font-medium text-ink hover:underline"
                          >
                            {row.title}
                          </Link>
                          <span className="text-xs text-ink-subtle">{row.customer.user.email}</span>
                        </td>
                        <td className="py-3 pr-3">
                          <Badge tone={row.state === "OFFERED" ? "accent" : "neutral"}>
                            {row.state.toLowerCase()}
                          </Badge>
                        </td>
                        <td className="py-3 pr-3 font-mono text-xs text-ink">
                          {row.matchingRuns[0]?.relaxationLevel ?? "—"}
                        </td>
                        <td className="py-3 pr-3 text-xs text-ink-muted">
                          {passed === 0
                            ? "—"
                            : `${String(declined)} declined · ${String(timedOut)} timed out`}
                        </td>
                        <td className="py-3 pr-5 text-right font-mono text-xs tabular-nums">
                          {Math.floor(secondsLeft / 60)}m {secondsLeft % 60}s
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
