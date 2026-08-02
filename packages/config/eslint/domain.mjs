import base from "./base.mjs";

/**
 * The load-bearing rule of this codebase (ARCHITECTURE.md §7).
 *
 * `packages/domain` contains pure business logic. It may import its own `ports/`
 * interfaces and `@sfx/contracts` types — nothing else. No framework, no ORM,
 * no vendor SDK.
 *
 * This is what keeps two promises honest:
 *   1. §29 — a mobile client can reuse the domain without dragging Next.js in.
 *   2. §35 — the matching engine is testable as pure functions, no database.
 *
 * Without enforcement this degrades silently the first time someone needs
 * "just one" Prisma call. With enforcement it fails in CI.
 */
const FORBIDDEN = [
  {
    group: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*"],
    message:
      "packages/domain must not import UI frameworks. Business logic belongs outside React (§36).",
  },
  {
    group: ["@prisma/client", "@prisma/*", ".prisma/*", "@sfx/db", "@sfx/db/*"],
    message:
      "packages/domain must not import the ORM. Define a repository interface in ports/ and implement it in packages/adapters.",
  },
  {
    group: ["@sfx/adapters", "@sfx/adapters/*"],
    message:
      "Dependency inversion runs one way: adapters depend on domain, never the reverse. Add a port instead.",
  },
  {
    group: [
      "stripe",
      "stripe/*",
      "razorpay",
      "@daily-co/*",
      "ably",
      "ably/*",
      "resend",
      "@aws-sdk/*",
      "@anthropic-ai/*",
      "pg-boss",
      "better-auth",
      "better-auth/*",
      "@sentry/*",
    ],
    message:
      "packages/domain must not import vendor SDKs (§37.6 — providers must stay replaceable). Depend on the port in ports/ instead.",
  },
];

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: FORBIDDEN }],
    },
  },
  {
    // Ports declare interfaces only. A port that imports a vendor type has
    // leaked the vendor into the domain through the back door.
    //
    // Sibling ports may reference each other (`./clock.js`); reaching UP into a
    // domain module (`../matching/...`) is what inverts the dependency and is
    // therefore what's blocked.
    files: ["src/ports/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...FORBIDDEN,
            {
              group: ["../*", "../../*"],
              message:
                "Ports must not depend on domain modules — that inverts the dependency. Import shared types from @sfx/contracts instead.",
            },
          ],
        },
      ],
    },
  },
];
