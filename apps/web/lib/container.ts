import {
  ConsoleLogger,
  MockPaymentGateway,
  MockPayoutProvider,
  PrismaUnitOfWork,
} from "@sfx/adapters";
import { prisma } from "@sfx/db";
import type { PrismaClient } from "@sfx/db";
import {
  AccountService,
  ExpertAdminService,
  ExpertApplicationService,
  systemClock,
  type Clock,
  type Logger,
  type PaymentGateway,
  type PayoutProvider,
  type UnitOfWork,
} from "@sfx/domain";
import { serverEnv } from "./env.js";

/**
 * Composition root — the one module allowed to know about concrete adapters
 * (ARCHITECTURE.md §7). Everything else receives interfaces.
 *
 * Swapping a provider is a change here and nowhere else. That is what lets
 * Phases 1–6 run on mocks while the payment and payout providers stay
 * undecided (§C2, Q3).
 */
export interface Container {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly uow: UnitOfWork;
  readonly paymentGateway: PaymentGateway;
  readonly payoutProvider: PayoutProvider;
  readonly accounts: AccountService;
  readonly expertApplications: ExpertApplicationService;
  readonly expertAdmin: ExpertAdminService;
}

let cached: Container | undefined;

function build(): Container {
  const env = serverEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "web" });
  const clock = systemClock;
  const uow = new PrismaUnitOfWork(prisma);

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

  return {
    prisma,
    clock,
    logger,
    uow,
    paymentGateway,
    payoutProvider,
    accounts: new AccountService(uow),
    expertApplications: new ExpertApplicationService(uow, clock),
    expertAdmin: new ExpertAdminService(uow, clock),
  };
}

export function getContainer(): Container {
  cached ??= build();
  return cached;
}
