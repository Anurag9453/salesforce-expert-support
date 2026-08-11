import { countryName, TIME_ZONE_META } from "@sfx/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, isDomainError, PROFICIENCY_GUIDANCE } from "@sfx/domain";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ExpertStatusBadge,
  PageHeader,
} from "@/components/ui";
import { DecisionPanel } from "@/components/admin/decision-panel";
import { SkillVerification } from "@/components/admin/skill-verification";
import { toExpertSkillView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Expert application" };
export const dynamic = "force-dynamic";

function formatAction(action: string): string {
  return action.replace(/^expert(_application)?\./, "").replace(/_/g, " ");
}

export default async function AdminExpertDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  if (!can(actor, "admin:read_experts")) redirect("/dashboard");

  const { id } = await params;
  const { expertAdmin, expertSkills } = getContainer();

  let view;
  let history;
  let skills;
  try {
    view = toExpertApplicationView(await expertAdmin.get(actor, id));
    [history, skills] = await Promise.all([
      expertAdmin.history(actor, id),
      expertSkills.listForExpert(actor, id),
    ]);
  } catch (error) {
    if (isDomainError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/experts" className="text-xs text-ink-muted hover:text-ink">
          ← All applications
        </Link>
        <PageHeader
          eyebrow="Admin"
          title="Application review"
          actions={
            <>
              <ExpertStatusBadge status={view.status} />
              {view.eligibleForMatching && (
                <Badge tone="available" dot>
                  eligible for matching
                </Badge>
              )}
            </>
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Decision</CardTitle>
        </CardHeader>
        <CardBody>
          <DecisionPanel application={view} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Declared skills</CardTitle>
        </CardHeader>
        <CardBody>
          {/*
            The expert declares; only an admin verifies (requirement 2). There is
            no control on the expert's own skills page that could set this, and
            no request shape that could carry it.
          */}
          <SkillVerification
            expertProfileId={id}
            initial={skills.map(toExpertSkillView)}
            guidance={PROFICIENCY_GUIDANCE}
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Application</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="space-y-3 text-sm">
              {(
                [
                  ["Country", view.country ? countryName(view.country) : null],
                  // A reviewer wants "IST · India Standard Time", not a raw IANA
                  // path they have to decode.
                  [
                    "Time zone",
                    view.timezone
                      ? [TIME_ZONE_META[view.timezone]?.abbr, TIME_ZONE_META[view.timezone]?.name]
                          .filter(Boolean)
                          .join(" · ") || view.timezone
                      : null,
                  ],
                  [
                    "Experience",
                    view.yearsExperience === null ? null : `${view.yearsExperience} years`,
                  ],
                  ["Languages", view.languages.join(", ") || null],
                  ["Certifications", view.certifications.join(", ") || null],
                  ["Employment", view.employmentStatus],
                  ["LinkedIn", view.linkedinUrl],
                  ["GitHub", view.githubUrl],
                  [
                    "Terms accepted",
                    view.termsAcceptedAt ? new Date(view.termsAcceptedAt).toLocaleString() : null,
                  ],
                  [
                    "Confidentiality accepted",
                    view.confidentialityAcceptedAt
                      ? new Date(view.confidentialityAcceptedAt).toLocaleString()
                      : null,
                  ],
                ] as Array<[string, string | null]>
              ).map(([label, value]) => (
                <div key={label} className="flex gap-3">
                  <dt className="w-44 shrink-0 text-ink-subtle">{label}</dt>
                  <dd className="text-ink">
                    {value ?? <span className="text-ink-subtle">—</span>}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-1.5 text-xs font-medium text-ink-subtle">Professional summary</p>
              <p className="whitespace-pre-wrap text-sm text-ink">
                {view.professionalSummary ?? "—"}
              </p>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            {/* Requirement 3 — who did what, when, rendered from the audit log. */}
            <CardTitle>Lifecycle history</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {history.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">No recorded activity.</p>
            ) : (
              <ol className="divide-y divide-border">
                {history.map((entry) => {
                  const after = entry.after as Record<string, unknown> | null;
                  const before = entry.before as Record<string, unknown> | null;
                  return (
                    <li key={entry.id} className="px-5 py-3.5">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium text-ink">
                          {formatAction(entry.action)}
                        </span>
                        {before?.status && after?.status ? (
                          <span className="text-xs text-ink-subtle">
                            {String(before.status)} → {String(after.status)}
                          </span>
                        ) : null}
                        <span className="ml-auto text-xs text-ink-subtle">
                          {entry.createdAt.toLocaleString()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-subtle">
                        by {String(after?.reviewedByEmail ?? entry.actorUserId ?? "system")} (
                        {entry.actorType.toLowerCase()})
                      </p>
                      {typeof after?.notes === "string" && after.notes.length > 0 && (
                        <p className="mt-1.5 text-sm text-ink-muted">{after.notes}</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      {view.status === "DRAFT" && (
        <Alert tone="info">
          This application has not been submitted yet. It is visible here for support purposes but
          is not in the review queue.
        </Alert>
      )}
    </div>
  );
}
