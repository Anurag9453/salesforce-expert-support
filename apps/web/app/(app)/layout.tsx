import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS, can } from "@sfx/domain";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { NavLinks, type NavLink } from "@/components/nav-links";
import { NotificationBell } from "@/components/notification-bell";
import { getActor } from "@/lib/session";

/**
 * Shell for every signed-in page.
 *
 * The redirect and the nav links are convenience, not security. Each page and
 * every API route independently re-authorizes through the domain, so removing
 * this layout would change what a user *sees* and nothing about what they can
 * *do* (requirement 4).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (actor === ANONYMOUS) redirect("/login");

  const links: NavLink[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/requests", label: "Requests" },
  ];

  // A dual-role account sees both. The customer side never disappears when
  // someone becomes an expert (requirement 1).
  if (can(actor, "expert_workspace:access")) {
    links.push({ href: "/expert", label: "Expert" });
  }
  if (actor.expert && !can(actor, "expert_workspace:access")) {
    links.push({ href: "/expert-application", label: "Application" });
  }
  if (can(actor, "admin:read_experts")) {
    links.push({ href: "/admin/experts", label: "Experts" });
  }
  if (can(actor, "admin:read_requests")) {
    links.push({ href: "/admin/requests", label: "In flight" });
  }
  if (can(actor, "admin:review_expert")) {
    links.push({ href: "/admin/photos", label: "Photos" });
  }

  return (
    <div className="min-h-dvh">
      {/*
        Sticky and translucent. An expert watching for an offer scrolls their
        skills list without losing the nav, and the blur keeps the header
        legible over whatever passes beneath it.
      */}
      <header className="sticky top-0 z-40 border-b border-border bg-surface-raised/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-5 px-6">
          <Link
            href="/dashboard"
            className="font-display interactive shrink-0 text-[0.9375rem] font-medium tracking-tight text-ink hover:text-accent"
          >
            Salesforce Expert Support
          </Link>

          {/*
            Scrolls rather than wraps: an admin with six links on a narrow
            window gets a swipeable strip instead of a header that grows to two
            rows and shoves the page down.
          */}
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <NavLinks links={links} />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden max-w-[12rem] truncate text-xs text-ink-subtle lg:inline">
              {actor.email}
            </span>
            <NotificationBell />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
