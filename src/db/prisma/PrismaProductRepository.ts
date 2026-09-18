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
