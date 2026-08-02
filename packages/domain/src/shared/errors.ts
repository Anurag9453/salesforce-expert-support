import type { ApiErrorCode, RequestState } from "@sfx/contracts";

/**
 * Domain errors carry the API error code with them, so the HTTP layer maps a
 * failure to a status without re-deriving intent from a message string (§37.13).
 */
export abstract class DomainError extends Error {
  abstract readonly code: ApiErrorCode;
  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  readonly code = "NOT_FOUND" as const;
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, { entity, id });
  }
}

export class ForbiddenError extends DomainError {
  readonly code = "FORBIDDEN" as const;
  constructor(action: string, resource: string) {
    super(`Not permitted to ${action} on ${resource}`, { action, resource });
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = "UNAUTHENTICATED" as const;
  constructor(message = "Authentication required") {
    super(message);
  }
}

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR" as const;
  constructor(
    message: string,
    readonly fields: Record<string, string[]> = {},
  ) {
    super(message, { fields });
  }
}

export class ConflictError extends DomainError {
  readonly code = "CONFLICT" as const;
}

/**
 * §16 — a state machine rejects an illegal move rather than silently tolerating
 * it. Carries both states so the log line is self-explanatory.
 *
 * Generic over the state type: the request lifecycle and the expert-application
 * lifecycle are different enums but the same class of failure, and constraining
 * this to `RequestState` would force one of them to cast.
 */
export class IllegalTransitionError<TState extends string = RequestState> extends DomainError {
  readonly code = "ILLEGAL_STATE_TRANSITION" as const;
  constructor(
    readonly from: TState,
    readonly to: TState,
    reason?: string,
  ) {
    super(`Illegal state transition ${from} → ${to}${reason ? `: ${reason}` : ""}`, {
      from,
      to,
      reason,
    });
  }
}

/** A guard on a legal transition failed (e.g. payment authorization lapsed). */
export class TransitionGuardError<TState extends string = RequestState> extends DomainError {
  readonly code = "CONFLICT" as const;
  constructor(
    readonly from: TState,
    readonly to: TState,
    readonly guard: string,
  ) {
    super(`Transition ${from} → ${to} blocked by guard: ${guard}`, { from, to, guard });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
