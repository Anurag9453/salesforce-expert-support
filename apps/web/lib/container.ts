import { ConsoleLogger, MockPaymentGateway, MockPayoutProvider } from "@sfx/adapters";
import { prisma } from "@sfx/db";
import {
  systemClock,
  type Clock,
  type Logger,
  type PaymentGateway,
  type PayoutProvider,
} from "@sfx/domain";
import type { PrismaClient } from "@sfx/db";
import { serverEnv } from "./env.js";

/**
 * Composition root — the one module allowed to know about concrete adapters
 * (ARCHITECTURE.md §7). Everything else receives interfaces.
 *
 * Swapping a provider is a change here and nowhere else. That is the whole
 * point of §37.6, and it is what lets Phases 1–6 run on mocks while the
 * payment and payout providers stay undecided (§C2, Q3).
 */
export interface Container {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly paymentGateway: PaymentGateway;
  readonly payoutProvider: PayoutProvider;
}

let cached: Container | undefined;

function build(): Container {
  const env = serverEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "web" });

  const paymentGateway: PaymentGateway = (() => {
    switch (env.PAYMENT_PROVIDER) {
      case "mock":
        return new MockPaymentGateway();
      // Phase 7a adds the real gateway once Q3 resolves. The exhaustive switch
      // means adding a provider to the enum without an adapter fails typecheck.
      default: {
        const never: never = env.PAYMENT_PROVIDER;
        throw new Error(`Unsupported PAYMENT_PROVIDER: ${String(never)}`);
      }
    }
  })();

  const payoutProvider: PayoutProvider = (() => {
    switch (env.PAYOUT_PROVIDER) {
      case "mock":
        return new MockPayoutProvider();
      default: {
        const never: never = env.PAYOUT_PROVIDER;
        throw new Error(`Unsupported PAYOUT_PROVIDER: ${String(never)}`);
      }
    }
  })();

  return { prisma, clock: systemClock, logger, paymentGateway, payoutProvider };
}

export function getContainer(): Container {
  cached ??= build();
  return cached;
}
