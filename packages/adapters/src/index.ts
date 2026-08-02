/**
 * Concrete implementations of the domain ports.
 *
 * Dependency direction runs one way: adapters depend on @sfx/domain, never the
 * reverse (enforced by @sfx/config/eslint/domain).
 *
 * Phase 1 ships mocks for payment and payout — the providers are undecided
 * until Q3 is answered (§C2) — plus the logger. Real adapters land per phase.
 */
export * from "./payment/mock-payment-gateway.js";
export * from "./payout/mock-payout-provider.js";
export * from "./observability/console-logger.js";
