import { cn } from "@/lib/utils";

/**
 * An expert's face on a customer-facing surface.
 *
 * `photoUrl` is null whenever there is nothing APPROVED to show — which covers
 * no photo, one awaiting review, and one that was rejected. The three are
 * deliberately indistinguishable here: a customer must not be able to infer that
 * someone uploaded a photo and it was refused.
 *
 * The placeholder is a silhouette rather than initials. Initials are a small
 * identity leak on a surface that otherwise shows a name only after selection,
 * and a launch bench with no photos would become a wall of letters.
 */
export function ExpertAvatar({
  photoUrl,
  name,
  size = "md",
  className,
}: {
  photoUrl: string | null;
  /** Used only as alt text when a photo exists. */
  name?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dimension = size === "sm" ? "size-10" : size === "lg" ? "size-20" : "size-14";

  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden rounded-full border border-border bg-surface-sunken",
        dimension,
        className,
      )}
    >
      {photoUrl ? (
        // Signed and short-lived, so next/image can neither fetch nor cache it.
        <img
          src={photoUrl}
          alt={name ? `${name}'s profile photo` : "Profile photo"}
          className="size-full object-cover"
        />
      ) : (
        <div className="grid size-full place-items-center text-ink-subtle" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="size-1/2"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  );
}
