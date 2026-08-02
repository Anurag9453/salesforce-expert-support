/**
 * Pure business logic. No framework, no ORM, no vendor SDK — enforced in CI.
 *
 *   shared/           Money, Result, DomainError
 *   ports/            every outbound dependency, as an interface
 *   authorization/    Actor + the permission matrix (server-side only)
 *   users/            account bootstrap
 *   experts/          application lifecycle, eligibility, admin review
 *   support-requests/ the §16 request state machine
 *
 * Matching (Phase 5), sessions (Phase 8) and payments (Phase 7) land here as
 * their phases open.
 */
export * from "./shared/index.js";
export * from "./ports/index.js";
export * from "./authorization/index.js";
export * from "./users/index.js";
export * from "./experts/index.js";
export * from "./support-requests/index.js";
