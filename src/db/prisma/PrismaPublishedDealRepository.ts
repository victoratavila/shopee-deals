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

  async countPublishedSince(sinceDate: Date, channel?: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP"): Promise<number> {
    return this.prisma.publishedDeal.count({
      where: { publishedAt: { gte: sinceDate }, ...(channel !== undefined ? { channel } : {}) },
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
    sourceRejectedOfferId?: string;
    searchCategoryId?: string;
    searchCategoryName?: string;
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
        sourceRejectedOfferId: entry.sourceRejectedOfferId ?? null,
        searchCategoryId: entry.searchCategoryId ?? null,
        searchCategoryName: entry.searchCategoryName ?? null,
      },
    });
  }

  /**
   * Isolamento Serializable: se duas chamadas concorrentes tentarem criar
   * uma publicação para o MESMO PRODUTO ao mesmo tempo, o Postgres detecta
   * o conflito e força uma delas a falhar (erro de serialização) em vez de
   * deixar as duas lerem "nada publicado ainda" e criarem duas entradas.
   * Tratamos essa falha de serialização como "não criou" (conservador -
   * seção 33: na dúvida, não duplicar), não como erro técnico.
   */
  async createIfNotRecentlyPublished(
    shopeeItemId: string,
    sinceDate: Date | null,
    entry: {
      productId: string;
      priceAtPublish: number;
      dealScore: number;
      channel: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP";
      runId?: string;
      approvedManually?: boolean;
      approvedBy?: string;
      sourceRejectedOfferId?: string;
      searchCategoryId?: string;
      searchCategoryName?: string;
    },
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ver nota em PrismaRunRepository
        async (tx: any) => {
          if (sinceDate !== null) {
            const recentCount = await tx.publishedDeal.count({
              where: { product: { shopeeItemId }, publishedAt: { gte: sinceDate } },
            });
            if (recentCount > 0) return false;
          }
          await tx.publishedDeal.create({
            data: {
              productId: entry.productId,
              priceAtPublish: entry.priceAtPublish,
              dealScore: entry.dealScore,
              channel: entry.channel,
              runId: entry.runId ?? null,
              approvedManually: entry.approvedManually ?? false,
              approvedBy: entry.approvedBy ?? null,
              sourceRejectedOfferId: entry.sourceRejectedOfferId ?? null,
              searchCategoryId: entry.searchCategoryId ?? null,
              searchCategoryName: entry.searchCategoryName ?? null,
            },
          });
          return true;
        },
        { isolationLevel: "Serializable" },
      );
    } catch (err) {
      const isSerializationConflict =
        err instanceof Error && "code" in err && (err as { code?: string }).code === "P2034";
      if (isSerializationConflict) return false;
      throw err;
    }
  }

  async findById(id: string) {
    const row = await this.prisma.publishedDeal.findUnique({ where: { id }, include: { product: true } });
    if (!row) return null;
    type Row = {
      id: string;
      productId: string;
      approvedManually: boolean;
      sourceRejectedOfferId: string | null;
      approvedBy: string | null;
      searchCategoryId: string | null;
      searchCategoryName: string | null;
      priceAtPublish: unknown;
      dealScore: unknown;
      channel: string;
      publishedAt: Date;
      product: {
        shopeeItemId: string;
        name: string;
        url: string;
        imageUrl: string | null;
        currentPrice: unknown;
        previousPrice: unknown;
        discountPercent: unknown;
        rating: unknown;
        ratingCount: number | null;
        salesCount: number | null;
        commissionPercent: unknown;
        affiliateLink: string | null;
        shopId: string | null;
      };
    };
    const r = row as Row;
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      id: r.id,
      productId: r.productId,
      shopeeItemId: r.product.shopeeItemId,
      approvedManually: r.approvedManually,
      sourceRejectedOfferId: r.sourceRejectedOfferId,
      approvedBy: r.approvedBy,
      searchCategoryId: r.searchCategoryId,
      searchCategoryName: r.searchCategoryName,
      priceAtPublish: Number(r.priceAtPublish),
      dealScore: Number(r.dealScore),
      channel: r.channel,
      publishedAt: r.publishedAt,
      productName: r.product.name,
      productUrl: r.product.url,
      productImageUrl: r.product.imageUrl,
      currentPrice: num(r.product.currentPrice),
      previousPrice: num(r.product.previousPrice),
      discountPercent: num(r.product.discountPercent),
      rating: num(r.product.rating),
      ratingCount: r.product.ratingCount,
      salesCount: r.product.salesCount,
      commissionPercent: num(r.product.commissionPercent),
      affiliateLink: r.product.affiliateLink,
      shopId: r.product.shopId,
    };
  }

  async delete(id: string): Promise<void> {
    await this.prisma.publishedDeal.delete({ where: { id } });
  }

  async deleteAll(): Promise<number> {
    const result = await this.prisma.publishedDeal.deleteMany({});
    return result.count;
  }

  async listRecent(limit: number) {
    const rows = await this.prisma.publishedDeal.findMany({
      orderBy: { publishedAt: "desc" },
      take: limit,
      include: { product: true },
    });
    type Row = {
      id: string;
      product: { name: string; imageUrl: string | null; affiliateLink: string | null };
      priceAtPublish: unknown;
      dealScore: unknown;
      channel: string;
      approvedManually: boolean;
      searchCategoryId: string | null;
      searchCategoryName: string | null;
      publishedAt: Date;
    };
    return rows.map((r: Row) => ({
      id: r.id,
      productName: r.product.name,
      productImageUrl: r.product.imageUrl,
      affiliateLink: r.product.affiliateLink,
      priceAtPublish: Number(r.priceAtPublish),
      dealScore: Number(r.dealScore),
      channel: r.channel,
      approvedManually: r.approvedManually,
      searchCategoryId: r.searchCategoryId,
      searchCategoryName: r.searchCategoryName,
      publishedAt: r.publishedAt,
    }));
  }
}
