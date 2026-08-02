import base from "./base.mjs";

/**
 * Web app config. The inverse of the domain rule: route handlers and components
 * must not reach past the domain layer straight into the database (§36).
 */
export default [
  ...base,
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@sfx/db", "@sfx/db/*", "@prisma/client"],
              message:
                "Routes and components must not query the database directly. Call a domain service; it owns authorization and invariants (§30 — security checks belong on the server, in one place).",
            },
          ],
        },
      ],
    },
  },
  {
    // The composition root is the one place allowed to know about concrete adapters.
    files: ["lib/container.ts", "lib/container/**/*.ts", "instrumentation.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
