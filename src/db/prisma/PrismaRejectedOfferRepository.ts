import type { PrismaClient } from "@prisma/client";
import type { RejectedOfferRepository, StoredRejectedOffer } from "../repositories.js";
import type { RejectedOfferResult } from "../../types/domain.js";

export class PrismaRejectedOfferRepository implements RejectedOfferRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordMany(runId: string, rejections: RejectedOfferResult[]): Promise<void> {
    if (rejections.length === 0) return;

    await this.prisma.rejectedOffer.createMany({
      data: rejections.map((r) => ({
        runId,
        shopeeItemId: r.shopeeItemId,
        productName: r.productName ?? null,
        reason: r.reason,
        details: r.details ?? null,
        offerSnapshot: r.offerSnapshot !== undefined ? JSON.stringify(r.offerSnapshot) : null,
      })),
    });
  }

  async findById(id: string): Promise<StoredRejectedOffer | null> {
    const row = await this.prisma.rejectedOffer.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      shopeeItemId: row.shopeeItemId,
      productName: row.productName,
      reason: row.reason,
      details: row.details,
      offerSnapshot: row.offerSnapshot,
      manuallyApprovedAt: row.manuallyApprovedAt,
      createdAt: row.createdAt,
    };
  }

  async markManuallyApproved(id: string, approvedBy: string): Promise<void> {
    await this.prisma.rejectedOffer.update({
      where: { id },
      data: { manuallyApprovedAt: new Date(), manuallyApprovedBy: approvedBy },
    });
  }

  async listRecent(limit: number): Promise<StoredRejectedOffer[]> {
    const rows = await this.prisma.rejectedOffer.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    type RawRow = {
      id: string;
      shopeeItemId: string;
      productName: string | null;
      reason: string;
      details: string | null;
      offerSnapshot: string | null;
      manuallyApprovedAt: Date | null;
      createdAt: Date;
    };
    return rows.map((row: RawRow) => ({
      id: row.id,
      shopeeItemId: row.shopeeItemId,
      productName: row.productName,
      reason: row.reason,
      details: row.details,
      offerSnapshot: row.offerSnapshot,
      manuallyApprovedAt: row.manuallyApprovedAt,
      createdAt: row.createdAt,
    }));
  }
}
