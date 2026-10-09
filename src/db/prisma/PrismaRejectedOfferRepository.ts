import type { PrismaClient } from "@prisma/client";
import type { RejectedOfferRepository, StoredRejectedOffer } from "../repositories.js";
import type { RejectedOfferResult, RejectionReason } from "../../types/domain.js";

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

  async createManual(entry: {
    shopeeItemId: string;
    productName?: string;
    reason: RejectionReason;
    details?: string;
    offerSnapshot: string;
  }): Promise<StoredRejectedOffer> {
    const row = await this.prisma.rejectedOffer.create({
      data: {
        runId: null,
        shopeeItemId: entry.shopeeItemId,
        productName: entry.productName ?? null,
        reason: entry.reason,
        details: entry.details ?? null,
        offerSnapshot: entry.offerSnapshot,
      },
    });
    return {
      id: row.id,
      shopeeItemId: row.shopeeItemId,
      productName: row.productName,
      reason: row.reason,
      details: row.details,
      offerSnapshot: row.offerSnapshot,
      manuallyApprovedAt: row.manuallyApprovedAt,
      manuallyApprovedBy: row.manuallyApprovedBy,
      createdAt: row.createdAt,
    };
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
      manuallyApprovedBy: row.manuallyApprovedBy,
      createdAt: row.createdAt,
    };
  }

  /**
   * updateMany com WHERE manuallyApprovedAt: null é a parte que garante
   * atomicidade: se duas requisições chegarem quase juntas (dois cliques
   * rápidos em "Aprovar"), só a primeira encontra a linha nesse estado e
   * a atualiza - a segunda não afeta nenhuma linha (count === 0) e sabe
   * que perdeu a corrida, sem precisar de uma checagem separada antes.
   */
  async claimManualApproval(id: string, approvedBy: string): Promise<boolean> {
    const result = await this.prisma.rejectedOffer.updateMany({
      where: { id, manuallyApprovedAt: null },
      data: { manuallyApprovedAt: new Date(), manuallyApprovedBy: approvedBy },
    });
    return result.count === 1;
  }

  async clearManualApproval(id: string): Promise<void> {
    await this.prisma.rejectedOffer.update({
      where: { id },
      data: { manuallyApprovedAt: null, manuallyApprovedBy: null },
    });
  }

  async countPending(since?: Date): Promise<number> {
    return this.prisma.rejectedOffer.count({
      where: {
        manuallyApprovedAt: null,
        ...(since !== undefined ? { createdAt: { gte: since } } : {}),
      },
    });
  }

  async listRecent(limit: number, since?: Date): Promise<StoredRejectedOffer[]> {
    const rows = await this.prisma.rejectedOffer.findMany({
      ...(since !== undefined ? { where: { createdAt: { gte: since } } } : {}),
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      shopeeItemId: row.shopeeItemId,
      productName: row.productName,
      reason: row.reason,
      details: row.details,
      offerSnapshot: row.offerSnapshot,
      manuallyApprovedAt: row.manuallyApprovedAt,
      manuallyApprovedBy: row.manuallyApprovedBy,
      createdAt: row.createdAt,
    }));
  }

  async deleteAllPending(): Promise<number> {
    const result = await this.prisma.rejectedOffer.deleteMany({
      where: { manuallyApprovedAt: null },
    });
    return result.count;
  }

  async deleteAll(): Promise<number> {
    const result = await this.prisma.rejectedOffer.deleteMany({});
    return result.count;
  }
}
