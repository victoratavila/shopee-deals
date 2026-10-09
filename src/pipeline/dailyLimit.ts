import type { Repositories } from "../db/repositories.js";
import type { OperationalSettings } from "../config/operationalSettings.js";
import type { RunMode } from "../types/domain.js";

export class DailyLimitReachedError extends Error {
  constructor(limit: number) {
    super(
      `O limite de ${limit} oferta(s) por dia já foi atingido hoje. Nenhuma nova execução (automática ou manual) roda até você aumentar esse número em Configurações, ou até o dia virar.`,
    );
    this.name = "DailyLimitReachedError";
  }
}

/**
 * Verifica se o limite diário de ofertas aprovadas já foi atingido, contando
 * só o canal correspondente ao modo efetivo (TEST só conta TEST, DRY_RUN só
 * conta DRY_RUN) - assim dá pra testar essa trava em TEST/DRY_RUN sem ela
 * "vazar" e se misturar com a contagem de outro modo.
 *
 * Usada em dois lugares:
 * 1. Antes de iniciar qualquer execução (scheduler ou manual) - se atingido,
 *    a execução nem começa (nenhum Run é criado).
 * 2. Na aprovação manual de uma oferta rejeitada - mesma regra, mesma fonte
 *    de verdade (reaproveita PublishedDeal.countPublishedSince, sem
 *    armazenamento novo).
 *
 * Não importa `channelForMode` de runPipeline.ts de propósito, para não
 * criar um import circular (runPipeline.ts também usa este arquivo) - o
 * mapeamento é o mesmo, só duplicado numa linha.
 */
export async function isDailyLimitReached(
  repos: Repositories,
  settings: OperationalSettings,
  effectiveMode: RunMode,
): Promise<boolean> {
  if (settings.maxOffersPerDay === null) return false;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const channel = effectiveMode === "TEST" ? "TEST" : "DRY_RUN";
  const publishedToday = await repos.publishedDeal.countPublishedSince(todayStart, channel);
  return publishedToday >= settings.maxOffersPerDay;
}
