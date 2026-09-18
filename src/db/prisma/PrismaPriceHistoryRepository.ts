import type { PrismaClient } from "@prisma/client";
import type { PriceHistoryRepository } from "../repositories.js";
import type { PriceStats } from "../../pricehistory/suspiciousPrice.js";

export class PrismaPriceHistoryRepository implements PriceHistoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getStats(productId: string): Promise<PriceStats | null> {
    const rows = await this.prisma.priceHistory.findMany({
      where: { productId },
      orderBy: { recordedAt: "desc" },
      take: 200, // limite razoável, evita carregar histórico ilimitado
    });

    if (rows.length === 0) return null;

    const prices: number[] = rows.map((r: { price: unknown }) => Number(r.price));
    const lowestPrice = Math.min(...prices);
    const averagePrice = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;

    return {
      lowestPrice,
      averagePrice,
      lastKnownPrice: prices[0] ?? null,
      sampleSize: prices.length,
    };
  }

  async recordIfChanged(productId: string, newPrice: number): Promise<void> {
    const last = await this.prisma.priceHistory.findFirst({
      where: { productId },
      orderBy: { recordedAt: "desc" },
    });

    if (last && Number(last.price) === newPrice) {
      return; // preço não mudou, não polui o histórico
    }

    await this.prisma.priceHistory.create({
      data: { productId, price: newPrice },
    });
  }
}
