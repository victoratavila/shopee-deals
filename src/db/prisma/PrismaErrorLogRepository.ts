import type { PrismaClient } from "@prisma/client";
import type { ErrorLogRepository } from "../repositories.js";

export class PrismaErrorLogRepository implements ErrorLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: {
    runId?: string;
    scope: string;
    message: string;
    stack?: string;
    context?: unknown;
  }): Promise<void> {
    await this.prisma.errorLog.create({
      data: {
        runId: entry.runId ?? null,
        scope: entry.scope,
        message: entry.message,
        stack: entry.stack ?? null,
        // Nunca gravar secrets/tokens aqui - somente contexto identificador (seção 19).
        context: entry.context !== undefined ? JSON.stringify(entry.context) : null,
      },
    });
  }
}
