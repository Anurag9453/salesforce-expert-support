import PgBoss from "pg-boss";
import type { Logger } from "@sfx/domain";
import type { BossLike } from "./pgboss-scheduler.js";

/**
 * A pg-boss client that only sends.
 *
 * The web app needs to enqueue classification and dispatch work, but must not
 * execute any: running handlers inside a request-serving process would put the
 * dispatch loop back where D2 says it must never be.
 *
 * `supervise: false` and `schedule: false` disable the maintenance and cron
 * machinery, so this holds a connection and nothing else. Whichever process
 * starts first creates the `pgboss` schema; the other finds it already there.
 */
export interface SendOnlyBossOptions {
  readonly connectionString: string;
  readonly logger: Logger;
}

export class SendOnlyBoss implements BossLike {
  private boss: PgBoss | undefined;
  private starting: Promise<PgBoss> | undefined;

  constructor(private readonly options: SendOnlyBossOptions) {}

  private async instance(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    // Concurrent first requests must share one start, not race N of them.
    this.starting ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.options.connectionString,
        schema: "pgboss",
        supervise: false,
        schedule: false,
        max: 2,
      });
      boss.on("error", (error: Error) => {
        this.options.logger.error("pg-boss (send-only) error", { error: error.message });
      });
      await boss.start();
      this.boss = boss;
      return boss;
    })();
    return this.starting;
  }

  async send(
    name: string,
    data: Record<string, unknown>,
    options?: { startAfter?: number; singletonKey?: string },
  ): Promise<string | null> {
    const boss = await this.instance();
    return boss.send(name, data, options ?? {});
  }

  async stop(): Promise<void> {
    if (this.boss) await this.boss.stop({ graceful: true, timeout: 5_000 });
    this.boss = undefined;
    this.starting = undefined;
  }
}
