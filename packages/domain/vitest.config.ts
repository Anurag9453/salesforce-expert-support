import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The domain is pure: no database, no network, no filesystem.
    // If a test here needs setup, something has leaked across the boundary.
  },
});
