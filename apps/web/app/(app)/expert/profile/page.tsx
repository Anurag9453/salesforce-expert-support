import { ADMIN_ONLY_PROFILE_FIELDS, can } from "@sfx/domain";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PhotoManager } from "@/components/expert/photo-manager";
import { ProfileEditor } from "@/components/expert/profile-editor";
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ExpertStatusBadge,
  PageHeader,
} from "@/components/ui";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { requireActor } from "@/lib/session";
import type { OwnPhotoView } from "@sfx/contracts";
import { photoUrlFor } from "@/lib/photo-view";

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

  const { expertProfiles, expertPhotos, storage } = getContainer();
  const record = await expertProfiles.getOwn(actor);
  const profile = toExpertApplicationView(record);

  // Their own photo, whatever its state — an expert needs to see a pending or
  // rejected one, which is exactly what customers must never see.
  const own = await expertPhotos.ownPhoto(actor);
  const photo: OwnPhotoView | null = own
    ? {
        id: own.id,
        status: own.status,
        url: own.uploadedAt ? await photoUrlFor(storage, own.storageKey) : null,
        reviewNote: own.reviewNote,
        uploadedAt: own.uploadedAt?.toISOString() ?? null,
        reviewedAt: own.reviewedAt?.toISOString() ?? null,
      }
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/expert", label: "Expert workspace" }}
        title="Your profile"
        description="Editing these does not send you back for review — none of them changes whether you are eligible to be matched."
        meta={<ExpertStatusBadge status={profile.status} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Profile photo</CardTitle>
        </CardHeader>
        <CardBody>
          <PhotoManager initial={photo} />
        </CardBody>
      </Card>

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
