import { ADMIN_ONLY_PROFILE_FIELDS, can } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ProfileEditor } from "@/components/expert/profile-editor";
import { Card, CardBody, CardHeader, CardTitle, ExpertStatusBadge } from "@/components/ui";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Your profile" };
export const dynamic = "force-dynamic";

/**
 * Profile editing (requirement 8).
 *
 * The editable half and the administrative half sit on the same page, visibly
 * separated. `ADMIN_ONLY_PROFILE_FIELDS` is imported rather than restated so
 * this page cannot claim a field is protected when the domain has quietly opened
 * it — the list and the enforcement come from the same constant.
 */
export default async function ExpertProfilePage() {
  const actor = await requireActor();
  if (!actor.expert || !can(actor, "expert_profile:read_own")) redirect("/dashboard");

  const record = await getContainer().expertProfiles.getOwn(actor);
  const profile = toExpertApplicationView(record);

  return (
    <div className="space-y-6">
      <header>
        <Link href="/expert" className="text-sm text-ink-muted hover:text-ink">
          ← Expert workspace
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Your profile</h1>
          <ExpertStatusBadge status={profile.status} />
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          Editing these does not send you back for review — none of them changes whether you are
          eligible to be matched.
        </p>
      </header>

      <ProfileEditor profile={profile} />

      <Card>
        <CardHeader>
          <CardTitle>Set by our review team</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-muted">
            These are not editable from here, by you or by this page. Requests to change them are
            rejected by the server, not merely hidden by the form.
          </p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-subtle">Application status</dt>
              <dd className="text-ink">{profile.status}</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Status changed</dt>
              <dd className="text-ink">{new Date(profile.statusChangedAt).toLocaleString()}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-ink-subtle">Review notes</dt>
              <dd className="text-ink">{profile.reviewNotes ?? "—"}</dd>
            </div>
          </dl>
          <details className="text-xs text-ink-subtle">
            <summary className="cursor-pointer">Full list of administrative fields</summary>
            <p className="mt-2 font-mono leading-relaxed">{ADMIN_ONLY_PROFILE_FIELDS.join(", ")}</p>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}
