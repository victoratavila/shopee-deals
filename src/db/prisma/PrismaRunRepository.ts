import type { PrismaClient } from "@prisma/client";
import type { RunRepository } from "../repositories.js";
import type { RunMode } from "../../types/domain.js";

export class PrismaRunRepository implements RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async hasActiveRun(): Promise<boolean> {
    const count = await this.prisma.run.count({ where: { status: "RUNNING" } });
    return count > 0;
  }

  async reconcileStaleRuns(maxAgeMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    const result = await this.prisma.run.updateMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "FAILED", finishedAt: new Date() },
    });
    return result.count;
  }

  async getLastFinishedAt(): Promise<Date | null> {
    const last = await this.prisma.run.findFirst({
      where: { finishedAt: { not: null } },
      orderBy: { finishedAt: "desc" },
    });
    return last?.finishedAt ?? null;
  }

  async create(mode: RunMode, triggeredBy: string): Promise<{ id: string }> {
    const run = await this.prisma.run.create({
      data: { mode, status: "RUNNING", triggeredBy },
    });
    return { id: run.id };
  }

  async finish(
    runId: string,
    stats: {
      status: "SUCCESS" | "FAILED" | "PARTIAL";
      productsFound: number;
      productsFiltered: number;
      dealsSelected: number;
      dealsPublished: number;
      errorsCount: number;
      durationMs: number;
    },
  ): Promise<void> {
    await this.prisma.run.update({
      where: { id: runId },
      data: {
        status: stats.status,
        productsFound: stats.productsFound,
        productsFiltered: stats.productsFiltered,
        dealsSelected: stats.dealsSelected,
        dealsPublished: stats.dealsPublished,
        errorsCount: stats.errorsCount,
        durationMs: stats.durationMs,
        finishedAt: new Date(),
      },
    });
  }
}
