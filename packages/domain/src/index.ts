/**
 * Pure business logic. No framework, no ORM, no vendor SDK — enforced in CI.
 *
 *   shared/           Money, Result, DomainError
 *   ports/            every outbound dependency, as an interface
 *   authorization/    Actor + the permission matrix (server-side only)
 *   users/            account bootstrap
 *   experts/          application lifecycle, eligibility, admin review
 *   security/         secret detection and redaction
 *   classification/   problem classification, non-blocking
 *   support-requests/ the §16 request state machine
 *   matching/         filters, scoring, ranking, the dispatch loop
 *
 * Sessions (Phase 8) and payments (Phase 7) land here as their phases open.
 */
export * from "./shared/index.js";
export * from "./ports/index.js";
export * from "./authorization/index.js";
export * from "./users/index.js";
export * from "./experts/index.js";
export * from "./security/index.js";
export * from "./classification/index.js";
export * from "./support-requests/index.js";
export * from "./matching/index.js";
export * from "./notifications/notification-service.js";
export * from "./billing/expert-fees.js";
export * from "./payments/webhook-service.js";
export * from "./payments/checkout-service.js";
export * from "./ports/crm.js";
export * from "./ports/payment-repository.js";
export * from "./sessions/session-lifecycle.js";
export * from "./shared/zoned-time.js";
