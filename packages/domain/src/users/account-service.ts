import type { Actor } from "../authorization/index.js";
import type { UnitOfWork, UserRecord } from "../ports/repositories.js";
import { NotFoundError } from "../shared/errors.js";

/**
 * Account bootstrap.
 *
 * Called on the first authenticated request of a session rather than from an
 * auth-provider hook, so it covers every sign-in path — email/password, Google,
 * and any provider added later — with one idempotent code path.
 */
export class AccountService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Ensure the customer side of a dual-role account exists.
   *
   * Requirement 1: CUSTOMER is the baseline for every account. An expert is a
   * customer who additionally applied, not a different kind of user — so the
   * customer profile is created for everyone and never removed when the EXPERT
   * role is added.
   */
  async ensureCustomerProfile(userId: string): Promise<void> {
    if (await this.uow.users.hasCustomerProfile(userId)) return;
    await this.uow.users.createCustomerProfile(userId);
  }

  async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.uow.users.findById(userId);
    if (!user) throw new NotFoundError("User", userId);
    return user;
  }

  /** Read-only view of the caller's own account. */
  async readSelf(actor: Actor): Promise<UserRecord> {
    return this.requireUser(actor.userId);
  }
}
