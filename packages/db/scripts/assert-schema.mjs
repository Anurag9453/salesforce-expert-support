#!/usr/bin/env node
/**
 * Post-migration assertions.
 *
 * Prisma cannot express partial indexes, so they live in hand-written SQL. That
 * makes them exactly the kind of thing a future `prisma migrate dev` can
 * silently fail to recreate after a schema reset.
 *
 * `one_open_offer_per_expert` in particular is not a performance index — it is
 * the mechanism that makes double-offering an expert impossible under
 * concurrency. If it disappears, nothing errors; the dispatch loop just becomes
 * quietly wrong. So we assert it, and `pnpm verify` fails if it is gone.
 */
import { PrismaClient } from "@prisma/client";

const REQUIRED_INDEXES = [
  {
    name: "one_open_offer_per_expert",
    table: "matching_attempts",
    why: "prevents an expert holding two live offers (ARCHITECTURE.md §3.4)",
    mustBeUnique: true,
  },
  {
    name: "expert_eligible_idx",
    table: "expert_profiles",
    why: "candidate query hot path",
    mustBeUnique: false,
  },
  {
    name: "request_in_flight_idx",
    table: "support_requests",
    why: "dispatch worker scan",
    mustBeUnique: false,
  },
  {
    name: "webhook_unprocessed_idx",
    table: "webhook_events",
    why: "webhook replay check",
    mustBeUnique: false,
  },
  {
    name: "one_active_tier_per_duration_currency",
    table: "pricing_tiers",
    why: "keeps quoting deterministic",
    mustBeUnique: true,
  },
];

const prisma = new PrismaClient();
const failures = [];

try {
  const rows = await prisma.$queryRaw`
    SELECT indexname, tablename, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `;
  const byName = new Map(rows.map((r) => [r.indexname, r]));

  for (const expected of REQUIRED_INDEXES) {
    const actual = byName.get(expected.name);
    if (!actual) {
      failures.push(`missing index "${expected.name}" on ${expected.table} — ${expected.why}`);
      continue;
    }
    if (!/\bWHERE\b/i.test(actual.indexdef)) {
      failures.push(`index "${expected.name}" lost its WHERE clause — ${expected.why}`);
    }
    if (expected.mustBeUnique && !/CREATE UNIQUE INDEX/i.test(actual.indexdef)) {
      failures.push(`index "${expected.name}" is no longer UNIQUE — ${expected.why}`);
    }
  }

  // Money must never be floating point. A Float on a *_cents / *_minor column is
  // a correctness bug that will not surface until reconciliation disagrees.
  const floatMoney = await prisma.$queryRaw`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (column_name ILIKE '%cents%' OR column_name ILIKE '%minor%' OR column_name ILIKE '%amount%')
      AND data_type IN ('double precision', 'real', 'numeric')
  `;
  for (const col of floatMoney) {
    failures.push(
      `${col.table_name}.${col.column_name} is ${col.data_type}; money must be integer minor units`,
    );
  }

  const tableCount = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'
  `;

  if (failures.length > 0) {
    console.error("schema assertions FAILED:");
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `schema ok — ${tableCount[0].n} tables, ${REQUIRED_INDEXES.length} partial indexes verified`,
    );
  }
} catch (error) {
  console.error("schema assertion error:", error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
