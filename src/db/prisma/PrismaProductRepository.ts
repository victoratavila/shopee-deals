import type { PrismaClient } from "@prisma/client";
import type { ProductRepository, StoredProduct } from "../repositories.js";
import type { RawShopeeOffer } from "../../types/domain.js";

export class PrismaProductRepository implements ProductRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByShopeeItemId(shopeeItemId: string): Promise<StoredProduct | null> {
    const product = await this.prisma.product.findUnique({ where: { shopeeItemId } });
    if (!product) return null;
    return { id: product.id, shopeeItemId: product.shopeeItemId, currentPrice: Number(product.currentPrice) };
  }

  async findLastProcessedAtByShopeeItemIds(shopeeItemIds: string[]): Promise<Map<string, Date>> {
    const itemIds = [...new Set(shopeeItemIds)];
    if (itemIds.length === 0) return new Map();

    const [products, rejections] = await Promise.all([
      this.prisma.product.findMany({
        where: { shopeeItemId: { in: itemIds } },
        select: { shopeeItemId: true, updatedAt: true },
      }),
      this.prisma.rejectedOffer.groupBy({
        by: ["shopeeItemId"],
        where: { shopeeItemId: { in: itemIds } },
        _max: { createdAt: true },
      }),
    ]);

    const lastProcessedAt = new Map<string, Date>();
    for (const product of products) {
      lastProcessedAt.set(product.shopeeItemId, product.updatedAt);
    }
    for (const rejection of rejections) {
      const rejectedAt = rejection._max.createdAt;
      if (rejectedAt === null) continue;
      const previous = lastProcessedAt.get(rejection.shopeeItemId);
      if (previous === undefined || rejectedAt > previous) {
        lastProcessedAt.set(rejection.shopeeItemId, rejectedAt);
      }
    }
    return lastProcessedAt;
  }

  async upsert(offer: RawShopeeOffer, affiliateLink: string): Promise<StoredProduct> {
    const data = {
      name: offer.name,
      url: offer.url,
      imageUrl: offer.imageUrl ?? null,
      category: offer.category ?? null,
      currentPrice: offer.currentPrice,
      previousPrice: offer.previousPrice ?? null,
      discountPercent: offer.discountPercent ?? null,
      rating: offer.rating ?? null,
      ratingCount: offer.ratingCount ?? null,
      salesCount: offer.salesCount ?? null,
      commissionPercent: offer.commissionPercent ?? null,
      affiliateLink,
      shopId: offer.shopId ?? null,
      lastSeenAt: new Date(),
    };

    const product = await this.prisma.product.upsert({
      where: { shopeeItemId: offer.shopeeItemId },
      create: { shopeeItemId: offer.shopeeItemId, ...data },
      update: data,
    });

    return { id: product.id, shopeeItemId: product.shopeeItemId, currentPrice: Number(product.currentPrice) };
  }
}
