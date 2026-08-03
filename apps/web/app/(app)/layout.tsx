import Link from "next/link";
import { redirect } from "next/navigation";
import { ANONYMOUS, can } from "@sfx/domain";
import { SignOutButton } from "@/components/auth/sign-out-button";
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

  const links: Array<{ href: string; label: string }> = [
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

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-6">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight text-ink">
            Salesforce Expert Support
          </Link>
          <nav className="flex items-center gap-4" aria-label="Main">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-ink-muted transition-colors hover:text-ink"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-ink-subtle sm:inline">{actor.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
