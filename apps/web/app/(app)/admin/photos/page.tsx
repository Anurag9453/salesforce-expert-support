import { can } from "@sfx/domain";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PhotoReview } from "@/components/admin/photo-review";
import { PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Photo review" };
export const dynamic = "force-dynamic";

export default async function AdminPhotosPage() {
  const actor = await requireActor();
  if (!can(actor, "admin:review_expert")) redirect("/dashboard");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Photo review"
        description="Every expert photo is checked by a person before a customer can see it. Oldest first — whoever has waited longest is reviewed first."
      />
      <PhotoReview />
    </div>
  );
}
