import type { DispatchCandidateView } from "@sfx/contracts";
import { can, EXCLUSION_COPY } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DispatchPanel } from "@/components/admin/dispatch-panel";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { buildMatchingAudit } from "@/lib/matching-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Matching inspection" };
export const dynamic = "force-dynamic";

/**
 * Requirement 4, as a page: "why was Expert B selected instead of Expert A?"
 *
 * Each run is one section, in the order they happened. Inside a run, the ranked
 * candidates come first with their score components, then everyone the filters
 * rejected with every reason. Nothing here is recomputed — the weights and floors
 * shown are the ones snapshotted onto the run (§C7), so reading this page in six
 * months still explains the decision that was actually made.
 */

const STATUS_TONE: Record<string, "neutral" | "accent" | "available" | "warning" | "danger"> = {
  EXCLUDED: "neutral",
  RANKED: "accent",
  OFFERED: "warning",
  ACCEPTED: "available",
  DECLINED: "danger",
  TIMED_OUT: "danger",
  SUPERSEDED: "neutral",
  WITHDRAWN: "neutral",
};

export default async function AdminRequestMatchingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!can(actor, "matching:read_audit")) redirect("/dashboard");

  const { id } = await params;
  const { prisma, matchingRepo } = getContainer();

  const audit = await buildMatchingAudit(prisma, id);
  if (!audit) notFound();

  const latestRun = await matchingRepo.latestRunForRequest(id);
  const latest = audit.runs.find((run) => run.id === latestRun?.id);
  const candidates: DispatchCandidateView[] = (latest?.attempts ?? []).map((attempt) => ({
    expertProfileId: attempt.expertProfileId,
    email: attempt.expertEmail,
    availabilityStatus: attempt.status === "OFFERED" ? "on_offer" : "—",
    expertStatus: "APPROVED",
    finalScore: attempt.status === "EXCLUDED" ? null : attempt.scores.final,
    rank: attempt.rank,
    exclusionReasons: attempt.exclusionReasons,
    assignable: attempt.status === "RANKED",
  }));

  const active = audit.state === "SEARCHING" || audit.state === "OFFERED";
  const accepted = audit.runs
    .flatMap((run) => run.attempts)
    .find((attempt) => attempt.status === "ACCEPTED");

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/experts" className="text-xs text-ink-muted hover:text-ink">
          ← Admin
        </Link>
        <PageHeader
          eyebrow="Admin"
          title="Matching inspection"
          actions={
            <>
              <Badge tone={active ? "accent" : "neutral"} dot={!active} pulse={active}>
                {audit.state}
              </Badge>
              <span className="text-xs text-ink-subtle">
                deadline{" "}
                <time dateTime={audit.matchDeadlineAt}>
                  {new Date(audit.matchDeadlineAt).toLocaleTimeString()}
                </time>
              </span>
            </>
          }
        />
        <p className="mt-1 text-sm text-ink-muted">
          {audit.runs.length} run{audit.runs.length === 1 ? "" : "s"}, oldest first. The weights and
          floors shown are the ones that were in force at the time.
        </p>
      </div>

      {accepted && (
        <Alert tone="success" title={`Accepted by ${accepted.expertEmail}`}>
          {accepted.origin === "ALGORITHMIC"
            ? `Ranked #${String(accepted.rank)} with a score of ${accepted.scores.final.toFixed(3)}. Answered in ${String(accepted.responseSeconds)}s.`
            : `Assigned manually (${accepted.origin}). Reason: ${accepted.adminReason ?? "—"}`}
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Manual dispatch</CardTitle>
        </CardHeader>
        <CardBody>
          <DispatchPanel supportRequestId={id} candidates={candidates} active={active} />
        </CardBody>
      </Card>

      {audit.runs.map((run) => {
        const ranked = run.attempts.filter((attempt) => attempt.status !== "EXCLUDED");
        const excluded = run.attempts.filter((attempt) => attempt.status === "EXCLUDED");
        const filters = run.filtersApplied as Record<string, unknown>;

        return (
          <Card key={run.id}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                Round {run.roundNumber} · relaxation {run.relaxationLevel}
              </CardTitle>
              <span className="text-xs text-ink-subtle">
                {new Date(run.startedAt).toLocaleTimeString()}
              </span>
            </CardHeader>
            <CardBody className="space-y-4">
              <p className="text-sm text-ink-muted">
                {typeof filters.describes === "string" ? filters.describes : ""}
              </p>
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-subtle">
                <div>
                  <dt className="inline">primary floor: </dt>
                  <dd className="inline font-medium text-ink">{String(filters.primaryFloor)}</dd>
                </div>
                <div>
                  <dt className="inline">secondary coverage: </dt>
                  <dd className="inline font-medium text-ink">
                    {String(filters.secondaryCoverage)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">rating floor: </dt>
                  <dd className="inline font-medium text-ink">
                    {filters.enforceRatingFloor ? "on" : "off"}
                  </dd>
                </div>
                <div>
                  <dt className="inline">category substitution: </dt>
                  <dd className="inline font-medium text-ink">
                    {filters.widenSecondaryToCategory ? "on" : "off"}
                  </dd>
                </div>
              </dl>

              {ranked.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[42rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-ink-subtle">
                        <th className="py-2 pr-3 font-medium">#</th>
                        <th className="py-2 pr-3 font-medium">Expert</th>
                        <th className="py-2 pr-3 font-medium">Band</th>
                        <th className="py-2 pr-3 font-medium">Skill</th>
                        <th className="py-2 pr-3 font-medium">Rating</th>
                        <th className="py-2 pr-3 font-medium">Exp</th>
                        <th className="py-2 pr-3 font-medium">Fair</th>
                        <th className="py-2 pr-3 font-medium">Rely</th>
                        <th className="py-2 pr-3 font-medium">Final</th>
                        <th className="py-2 font-medium">Outcome</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {ranked.map((attempt) => (
                        <tr key={attempt.id}>
                          <td className="py-2 pr-3 text-ink-subtle">{attempt.rank ?? "—"}</td>
                          <td className="max-w-[14rem] truncate py-2 pr-3 text-ink">
                            {attempt.expertEmail}
                            {attempt.origin !== "ALGORITHMIC" && (
                              // Requirement 13 — visibly distinguishable, forever.
                              <Badge tone="warning" className="ml-2">
                                manual
                              </Badge>
                            )}
                          </td>
                          {/*
                            The band is the number that makes primary competence
                            dominate: candidates are ordered by it before the
                            weighted score is consulted at all.
                          */}
                          <td className="py-2 pr-3 font-mono text-xs text-ink">
                            {typeof attempt.breakdown?.primaryBand === "number"
                              ? attempt.breakdown.primaryBand
                              : "—"}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {attempt.scores.skill.toFixed(3)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {attempt.scores.rating.toFixed(3)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {attempt.scores.experience.toFixed(3)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {attempt.scores.fairness.toFixed(3)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs">
                            {attempt.scores.reliability.toFixed(3)}
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs font-semibold text-ink">
                            {attempt.scores.final.toFixed(3)}
                          </td>
                          <td className="py-2">
                            <Badge tone={STATUS_TONE[attempt.status] ?? "neutral"}>
                              {attempt.status.toLowerCase()}
                            </Badge>
                            {attempt.declineReason && (
                              <span className="ml-1.5 text-xs text-ink-subtle">
                                {attempt.declineReason.toLowerCase().replace(/_/g, " ")}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {excluded.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-ink-muted">
                    {excluded.length} candidate{excluded.length === 1 ? "" : "s"} excluded — and why
                  </summary>
                  <ul className="mt-2 divide-y divide-border">
                    {excluded.map((attempt) => (
                      <li key={attempt.id} className="py-2">
                        <p className="text-ink">{attempt.expertEmail}</p>
                        <ul className="mt-0.5 text-xs text-ink-subtle">
                          {attempt.exclusionReasons.map((reason) => (
                            <li key={reason}>· {EXCLUSION_COPY[reason] ?? reason}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}
