/**
 * Injected time and identity.
 *
 * The dispatch loop is built on deadlines — a 60-second offer window and a
 * 15-minute matching window. Tests must be able to advance time without
 * sleeping, so nothing in the domain calls `Date.now()` or `crypto.randomUUID()`
 * directly (§35).
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

/** Production implementation. Trivial, but it belongs behind the port. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test double: deterministic, advanceable. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceBy(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = new Date(date);
  }
}
