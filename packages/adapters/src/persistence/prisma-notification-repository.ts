import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type { NotificationRecord, NotificationRepository } from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

/**
 * In-app notifications over the existing `notifications` table.
 *
 * The table has always been there and nothing wrote to it — the bell is the
 * first reader, so this is also the first writer.
 *
 * `payload` is JSON in the schema and a notification's shape is stable (title,
 * body, href), so it is read defensively here rather than trusted: a row written
 * by an older or newer version of the app must render as *something* rather than
 * crashing the header on every page.
 */
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    eventType: string;
    channel: "IN_APP" | "EMAIL" | "PUSH" | "SMS";
    payload: Readonly<Record<string, unknown>>;
    createdAt: Date;
  }): Promise<void> {
    await this.db.notification.create({
      data: {
        userId: input.userId,
        eventType: input.eventType,
        channel: input.channel,
        payload: input.payload as object,
        // IN_APP has no delivery step: writing the row *is* the delivery, so it
        // is SENT immediately rather than sitting PENDING forever waiting for a
        // dispatcher that does not exist for this channel.
        status: "SENT",
        sentAt: input.createdAt,
      },
    });
  }

  async listForUser(params: {
    userId: string;
    limit: number;
  }): Promise<readonly NotificationRecord[]> {
    const rows = await this.db.notification.findMany({
      where: { userId: params.userId, channel: "IN_APP" },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
    return rows.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        eventType: row.eventType,
        title: typeof payload.title === "string" ? payload.title : row.eventType,
        body: typeof payload.body === "string" ? payload.body : null,
        href: typeof payload.href === "string" ? payload.href : null,
        readAt: row.readAt,
        createdAt: row.createdAt,
      };
    });
  }

  async createForExpertProfile(input: {
    expertProfileId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    createdAt: Date;
  }): Promise<void> {
    const profile = await this.db.expertProfile.findUnique({
      where: { id: input.expertProfileId },
      select: { userId: true },
    });
    if (!profile) return;
    await this.create({
      userId: profile.userId,
      eventType: input.eventType,
      channel: "IN_APP",
      payload: input.payload,
      createdAt: input.createdAt,
    });
  }

  async createForCustomerProfile(input: {
    customerProfileId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    createdAt: Date;
  }): Promise<void> {
    const profile = await this.db.customerProfile.findUnique({
      where: { id: input.customerProfileId },
      select: { userId: true },
    });
    if (!profile) return;
    await this.create({
      userId: profile.userId,
      eventType: input.eventType,
      channel: "IN_APP",
      payload: input.payload,
      createdAt: input.createdAt,
    });
  }

  async countUnread(userId: string): Promise<number> {
    return this.db.notification.count({
      where: { userId, channel: "IN_APP", readAt: null },
    });
  }

  async markAllRead(params: { userId: string; readAt: Date }): Promise<number> {
    const result = await this.db.notification.updateMany({
      where: { userId: params.userId, channel: "IN_APP", readAt: null },
      data: { readAt: params.readAt, status: "READ" },
    });
    return result.count;
  }
}
