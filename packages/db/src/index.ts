import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { PrismaClient };

declare global {
  var __sfxPrisma: PrismaClient | undefined;
}

/**
 * Single Prisma instance per process.
 *
 * Next.js dev hot-reloads module state, which without this guard opens a new
 * connection pool on every edit until Postgres refuses them.
 */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? [
            { emit: "stdout", level: "warn" },
            { emit: "stdout", level: "error" },
          ]
        : [{ emit: "stdout", level: "error" }],
  });
}

export const prisma: PrismaClient = globalThis.__sfxPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__sfxPrisma = prisma;
}

/** Narrow type for anything that can run inside an interactive transaction. */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
