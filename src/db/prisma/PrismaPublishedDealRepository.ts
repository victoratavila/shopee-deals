import type { PrismaClient } from "@prisma/client";
import type { PublishedDealRepository } from "../repositories.js";

export class PrismaPublishedDealRepository implements PublishedDealRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async wasRecentlyPublished(shopeeItemId: string, sinceDate: Date): Promise<boolean> {
    const count = await this.prisma.publishedDeal.count({
      where: {
        product: { shopeeItemId },
        publishedAt: { gte: sinceDate },
      },
    });
    return count > 0;
  }

  async countPublishedSince(sinceDate: Date): Promise<number> {
    return this.prisma.publishedDeal.count({
      where: { publishedAt: { gte: sinceDate } },
    });
  }

  async create(entry: {
    productId: string;
    priceAtPublish: number;
    dealScore: number;
    channel: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP";
    runId?: string;
    approvedManually?: boolean;
    approvedBy?: string;
  }): Promise<void> {
    await this.prisma.publishedDeal.create({
      data: {
        productId: entry.productId,
        priceAtPublish: entry.priceAtPublish,
        dealScore: entry.dealScore,
        channel: entry.channel,
        runId: entry.runId ?? null,
        approvedManually: entry.approvedManually ?? false,
        approvedBy: entry.approvedBy ?? null,
      },
    });
  }

  async listRecent(limit: number) {
    const rows = await this.prisma.publishedDeal.findMany({
      orderBy: { publishedAt: "desc" },
      take: limit,
      include: { product: true },
    });
    return rows.map((r: { id: string; product: { name: string }; priceAtPublish: unknown; dealScore: unknown; channel: string; approvedManually: boolean; publishedAt: Date }) => ({
      id: r.id,
      productName: r.product.name,
      priceAtPublish: Number(r.priceAtPublish),
      dealScore: Number(r.dealScore),
      channel: r.channel,
      approvedManually: r.approvedManually,
      publishedAt: r.publishedAt,
    }));
  }
}
