import type { PrismaClient } from "@prisma/client";
import type { RunRepository } from "../repositories.js";
import { ConcurrentRunError } from "../repositories.js";
import type { RunMode } from "../../types/domain.js";

const LOCK_ID = 1;

export class PrismaRunRepository implements RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async hasActiveRun(): Promise<boolean> {
    const lock = await this.prisma.schedulerLock.findUnique({ where: { id: LOCK_ID } });
    return lock?.locked ?? false;
  }

  async reconcileStaleRuns(maxAgeMinutes: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    const result = await this.prisma.run.updateMany({
      where: { status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "FAILED", finishedAt: new Date() },
    });

    // Um processo recém-iniciado nunca tem uma execução legitimamente
    // ativa - por isso o lock é sempre liberado aqui (e criado, se ainda
    // não existir), independente da idade de qualquer Run que tenha
    // ficado travado. Isso garante recuperação imediata após reinício,
    // em vez de esperar até maxAgeMinutes passar (seção 12/18).
    await this.prisma.schedulerLock.upsert({
      where: { id: LOCK_ID },
      create: { id: LOCK_ID, locked: false },
      update: { locked: false, runId: null },
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

  async countRunsSince(sinceDate: Date): Promise<{ schedulerCount: number; manualCount: number; totalCount: number }> {
    const [totalCount, schedulerCount, manualCount] = await Promise.all([
      this.prisma.run.count({ where: { startedAt: { gte: sinceDate } } }),
      this.prisma.run.count({ where: { startedAt: { gte: sinceDate }, triggeredBy: "scheduler" } }),
      this.prisma.run.count({ where: { startedAt: { gte: sinceDate }, triggeredBy: { startsWith: "manual:" } } }),
    ]);
    return { schedulerCount, manualCount, totalCount };
  }

  /**
   * Adquire o lock e cria o Run numa única transação. Se o lock já estiver
   * ativo (outra execução em andamento), a atualização condicional não afeta
   * nenhuma linha e lançamos ConcurrentRunError - como essa checagem não é
   * uma etapa separada da criação, não existe brecha para duas execuções
   * concorrentes (scheduler + manual, ou dois cliques rápidos) passarem ao
   * mesmo tempo.
   */
  async create(mode: RunMode, triggeredBy: string): Promise<{ id: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ver comentário acima
    return this.prisma.$transaction(async (tx: any) => {
      const lockResult = await tx.schedulerLock.updateMany({
        where: { id: LOCK_ID, locked: false },
        data: { locked: true, lockedAt: new Date() },
      });

      if (lockResult.count === 0) {
        throw new ConcurrentRunError();
      }

      const run = await tx.run.create({ data: { mode, status: "RUNNING", triggeredBy } });
      await tx.schedulerLock.update({ where: { id: LOCK_ID }, data: { runId: run.id } });
      return { id: run.id };
    });
  }

  /** Finaliza o Run e libera o lock na mesma transação. */
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
    await this.prisma.$transaction([
      this.prisma.run.update({
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
      }),
      this.prisma.schedulerLock.update({ where: { id: LOCK_ID }, data: { locked: false, runId: null } }),
    ]);
  }
}
