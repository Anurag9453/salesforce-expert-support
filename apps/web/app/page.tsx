import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";

/**
 * Phase 1 scaffold page — deliberately NOT the marketing landing page.
 *
 * §4's landing page is Phase 3 work. This exists to prove the design tokens,
 * the primitives, and the build pipeline render, and to make the phase status
 * legible to anyone who opens the app.
 */

const PHASES = [
  { n: 1, name: "Foundation", state: "current" },
  { n: 2, name: "Accounts", state: "next" },
  { n: 3, name: "Support requests", state: "pending" },
  { n: 4, name: "Expert availability", state: "pending" },
  { n: 5, name: "Matching engine", state: "pending" },
  { n: 6, name: "Realtime dispatch — MVP checkpoint", state: "pending" },
] as const;

const FOUNDATION = [
  ["Monorepo", "apps/web · apps/worker · 5 packages"],
  ["Domain boundary", "enforced in CI, not by convention"],
  ["Schema", "V1 tables + partial unique indexes"],
  ["State machine", "§16 transitions as data"],
  ["Payments", "mock — provider undecided (Q3)"],
  ["Classifier", "mock — Haiku 4.5 when a key exists"],
] as const;

export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <Badge tone="accent">Phase 1 · Foundation</Badge>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">
          Salesforce Instant Expert Support
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
          Scaffold and design-system check. The customer-facing landing page ships in Phase 3; the
          dispatch loop that makes this a product ships in Phase 6.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Foundation in place</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="space-y-2.5 text-sm">
              {FOUNDATION.map(([label, detail]) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <dt className="font-medium text-ink">{label}</dt>
                  <dd className="text-xs text-ink-subtle">{detail}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Roadmap</CardTitle>
          </CardHeader>
          <CardBody>
            <ol className="space-y-2 text-sm">
              {PHASES.map((phase) => (
                <li key={phase.n} className="flex items-center justify-between gap-3">
                  <span className={phase.state === "pending" ? "text-ink-subtle" : "text-ink"}>
                    {phase.n}. {phase.name}
                  </span>
                  {phase.state === "current" && <Badge tone="available">current</Badge>}
                  {phase.state === "next" && <Badge>next</Badge>}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button size="md" disabled>
          Get Expert Help
        </Button>
        <Button size="md" variant="secondary" disabled>
          Become an Expert
        </Button>
        <span className="text-xs text-ink-subtle">both wired in Phase 2–3</span>
      </div>

      <p className="mt-10 border-t border-border pt-6 text-xs leading-relaxed text-ink-subtle">
        Never share passwords, access tokens, private keys, or production customer data through this
        platform. Health Cloud technical support is in scope; actual patient data is not.
      </p>
    </main>
  );
}
