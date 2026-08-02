/**
 * Pure business logic. No framework, no ORM, no vendor SDK — enforced in CI.
 *
 * Phase 1 establishes the primitives every later phase builds on:
 *   • shared/           Money, Result, DomainError
 *   • ports/            every outbound dependency, as an interface
 *   • support-requests/ the §16 state machine
 *
 * Matching (Phase 5), sessions (Phase 8) and payments (Phase 7) land here as
 * their phases open.
 */
export * from "./shared/index.js";
export * from "./ports/index.js";
export * from "./support-requests/index.js";
