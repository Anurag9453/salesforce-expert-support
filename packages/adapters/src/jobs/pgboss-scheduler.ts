import type { JobScheduler, Logger } from "@sfx/domain";

/**
 * Enqueues into pg-boss.
 *
 * Typed against the small slice of pg-boss the domain needs rather than the
 * client itself, so the web app can enqueue without importing the worker's
 * dependency tree.
 */
export interface BossLike {
  send(
    name: string,
    data: Record<string, unknown>,
    options?: { startAfter?: number; singletonKey?: string },
  ): Promise<string | null>;
}

export class PgBossScheduler implements JobScheduler {
  readonly name = "pg-boss";

  constructor(
    private readonly boss: BossLike,
    private readonly logger: Logger,
  ) {}

  async enqueue(params: {
    queue: string;
    payload: Record<string, unknown>;
    runAfterSeconds?: number;
    singletonKey?: string;
  }): Promise<void> {
    const id = await this.boss.send(params.queue, params.payload, {
      ...(params.runAfterSeconds !== undefined ? { startAfter: params.runAfterSeconds } : {}),
      ...(params.singletonKey !== undefined ? { singletonKey: params.singletonKey } : {}),
    });

    if (id === null) {
      // pg-boss returns null when a singleton key collapses the send. That is
      // the intended outcome for a retried enqueue, not a failure.
      this.logger.debug("job collapsed by singleton key", {
        queue: params.queue,
        singletonKey: params.singletonKey,
      });
      return;
    }
    this.logger.debug("job enqueued", { queue: params.queue, jobId: id });
  }
}

/**
 * Records intent without a queue behind it.
 *
 * Used by the web app in local development so submitting a request works with no
 * worker running — the request still reaches CLASSIFYING, and the worker picks it
 * up whenever it starts.
 */
export class NoopScheduler implements JobScheduler {
  readonly name = "noop";
  constructor(private readonly logger: Logger) {}

  async enqueue(params: { queue: string; payload: Record<string, unknown> }): Promise<void> {
    this.logger.warn("job not enqueued — no scheduler configured", {
      queue: params.queue,
      payload: params.payload,
    });
  }
}
