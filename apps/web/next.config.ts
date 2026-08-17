import { join } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, not build output. One less build
  // step, and `go to definition` lands on the real file.
  transpilePackages: ["@sfx/domain", "@sfx/contracts", "@sfx/db", "@sfx/adapters"],
  // Prisma ships native query engines; bundling it into the server runtime
  // breaks them. Top-level in Next 15 (it left `experimental` in this release).
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
  /*
    Force the CA certificate into the deployed bundle.

    Vercel ships only the files its tracer can see, and it works by following
    imports. Our certificate is never imported — it is named by a path inside a
    database connection string, which is an opaque string as far as any bundler is
    concerned. Without this the file is simply absent in production and every
    `sslmode=verify-full` connection fails on a missing CA, at runtime, after a
    build that looked fine.
  */
  /*
    Trace from the monorepo root, not from this app directory.

    `outputFileTracingIncludes` below names a path above `apps/web`, and Next
    will not carry files from outside the tracing root into the bundle. The
    default root is the directory holding this config, so without this the
    include silently does nothing — the build succeeds and the certificate is
    absent at runtime.
  */
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  outputFileTracingIncludes: {
    "/**": ["../../certs/**"],
  },
  webpack(config) {
    // The workspace packages write `./thing.js` in relative imports — the
    // portable ESM convention, and what plain Node would need. Webpack does not
    // map that back to the `.ts` source on its own, so teach it to.
    // Without this the whole monorepo would have to drop extensions, which
    // would silently break if we ever emit real ESM.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  async headers() {
    // §30 — secure headers. CSP arrives in Phase 11 once the provider
    // origins (Ably, Daily, the payment gateway) are actually known.
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
        ],
      },
    ];
  },
};

export default config;
