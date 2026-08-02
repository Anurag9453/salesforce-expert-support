import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * A test for the rule that everything else rests on.
 *
 * ARCHITECTURE.md §7 claims the domain boundary is "enforced in CI, not by
 * convention". That claim is only true if the lint rule actually fires — and a
 * misconfigured `no-restricted-imports` fails open, silently permitting exactly
 * what it was added to prevent.
 *
 * So we lint synthetic violations and assert each one is rejected. If someone
 * loosens the config later, this fails rather than the boundary quietly eroding
 * until the first "just one Prisma call" ships.
 */

const eslint = new ESLint({ cwd: new URL("../", import.meta.url).pathname });

async function errorsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2)
    .map((message) => `${message.ruleId}: ${message.message}`);
}

const FORBIDDEN_IN_DOMAIN = [
  {
    label: "the ORM",
    code: `import { PrismaClient } from "@prisma/client";\nexport const x = PrismaClient;`,
  },
  { label: "the db package", code: `import { prisma } from "@sfx/db";\nexport const x = prisma;` },
  { label: "React", code: `import { useState } from "react";\nexport const x = useState;` },
  {
    label: "Next.js",
    code: `import { NextResponse } from "next/server";\nexport const x = NextResponse;`,
  },
  {
    label: "the adapters package",
    code: `import { ConsoleLogger } from "@sfx/adapters";\nexport const x = ConsoleLogger;`,
  },
  { label: "a payment SDK", code: `import Stripe from "stripe";\nexport const x = Stripe;` },
  { label: "the job queue", code: `import PgBoss from "pg-boss";\nexport const x = PgBoss;` },
  {
    label: "the AI SDK",
    code: `import Anthropic from "@anthropic-ai/sdk";\nexport const x = Anthropic;`,
  },
];

describe("domain boundary is actually enforced", () => {
  for (const { label, code } of FORBIDDEN_IN_DOMAIN) {
    it(`rejects importing ${label}`, async () => {
      const errors = await errorsFor(code, "src/matching/scoring.ts");
      expect(
        errors.some((error) => error.startsWith("no-restricted-imports")),
        `importing ${label} into the domain should be an error, but lint reported: ${
          errors.length > 0 ? errors.join("; ") : "nothing"
        }`,
      ).toBe(true);
    });
  }

  it("permits @sfx/contracts, which the domain legitimately depends on", async () => {
    const errors = await errorsFor(
      `import type { RequestState } from "@sfx/contracts";\nexport type X = RequestState;`,
      "src/matching/scoring.ts",
    );
    expect(errors.filter((e) => e.startsWith("no-restricted-imports"))).toEqual([]);
  });

  it("permits a port importing a sibling port", async () => {
    // The barrel file in ports/ must keep working; only reaching UP into a
    // domain module is forbidden.
    const errors = await errorsFor(`export * from "./clock.js";`, "src/ports/index.ts");
    expect(errors.filter((e) => e.startsWith("no-restricted-imports"))).toEqual([]);
  });

  it("stops a port from reaching up into a domain module", async () => {
    const errors = await errorsFor(
      `import { splitFee } from "../shared/money.js";\nexport const x = splitFee;`,
      "src/ports/payment.ts",
    );
    expect(errors.some((e) => e.startsWith("no-restricted-imports"))).toBe(true);
  });
});
