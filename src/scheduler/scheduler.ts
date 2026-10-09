import cron from "node-cron";
import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import type { Repositories } from "../db/repositories.js";
import type { RunMode } from "../types/domain.js";
import { runPipeline, ConcurrentRunError, DailyLimitReachedError, type PipelineResult } from "../pipeline/runPipeline.js";
import { isDailyLimitReached } from "../pipeline/dailyLimit.js";

export interface SchedulerDeps {
  shopeeClient: ShopeeClient;
  repos: Repositories;
  /** Modo fixo vindo do ambiente. Se for "TEST", o scheduler sempre roda em TEST. */
  envRunMode: RunMode;
  logger?: { info: (msg: string) => void; error: (msg: string, err?: unknown) => void };
}

/**
 * Resolve o modo efetivo de uma execução automática:
 * - RUN_MODE=TEST no ambiente sempre força TEST (útil em homologação);
 * - caso contrário, o kill switch/toggle DRY_RUN no painel decide entre
 *   DRY_RUN (nada é publicado de verdade) e PRODUCTION.
 */
export function resolveEffectiveMode(envRunMode: RunMode, dryRunEnabled: boolean): RunMode {
  if (envRunMode === "TEST") return "TEST";
  return dryRunEnabled ? "DRY_RUN" : "PRODUCTION";
}

/** Verifica se o horário atual está dentro da janela de funcionamento configurada. */
export function isWithinOperatingHours(now: Date, startHour: number, endHour: number): boolean {
  const hour = now.getHours();
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  // janela que atravessa a meia-noite, ex: 22h às 6h
  return hour >= startHour || hour < endHour;
}

export interface TickDecision {
  shouldRun: boolean;
  reason: string;
}

/**
 * Decide se uma nova rodada deve iniciar agora. Função pura (recebe tudo
 * já calculado), para ser testável sem depender de cron nem de tempo real.
 */
export function decideTick(params: {
  now: Date;
  automationEnabled: boolean;
  automationStartHour: number;
  automationEndHour: number;
  intervalBetweenRoundsMinutes: number;
  lastRunFinishedAt: Date | null;
  hasActiveRun: boolean;
  dailyLimitReached: boolean;
}): TickDecision {
  if (!params.automationEnabled) {
    return { shouldRun: false, reason: "Automação desativada (kill switch)" };
  }
  if (params.hasActiveRun) {
    return { shouldRun: false, reason: "Já existe uma execução em andamento" };
  }
  if (params.dailyLimitReached) {
    return { shouldRun: false, reason: "Limite diário de ofertas já foi atingido" };
  }
  if (!isWithinOperatingHours(params.now, params.automationStartHour, params.automationEndHour)) {
    return { shouldRun: false, reason: "Fora do horário de funcionamento configurado" };
  }
  if (params.lastRunFinishedAt) {
    const elapsedMinutes = (params.now.getTime() - params.lastRunFinishedAt.getTime()) / 60_000;
    if (elapsedMinutes < params.intervalBetweenRoundsMinutes) {
      return { shouldRun: false, reason: "Intervalo mínimo entre rodadas ainda não atingido" };
    }
  }
  return { shouldRun: true, reason: "Condições satisfeitas" };
}

export async function schedulerTick(deps: SchedulerDeps): Promise<PipelineResult | null> {
  const { repos, shopeeClient, envRunMode, logger } = deps;
  const settings = await repos.settings.getOperationalSettings();
  const hasActiveRun = await repos.run.hasActiveRun();
  const lastRunFinishedAt = await repos.run.getLastFinishedAt();
  const mode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
  const dailyLimitReached = await isDailyLimitReached(repos, settings, mode);

  const decision = decideTick({
    now: new Date(),
    automationEnabled: settings.automationEnabled,
    automationStartHour: settings.automationStartHour,
    automationEndHour: settings.automationEndHour,
    intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
    lastRunFinishedAt,
    hasActiveRun,
    dailyLimitReached,
  });

  if (!decision.shouldRun) {
    return null;
  }

  try {
    const result = await runPipeline({ shopeeClient, repos, mode, triggeredBy: "scheduler" });
    logger?.info(
      `[scheduler] execução concluída (mode=${mode}): ${result.dealsSelected} selecionadas, ${result.productsFiltered} rejeitadas, ${result.errorsCount} erros`,
    );
    return result;
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      logger?.info("[scheduler] execução concorrente detectada, pulando este tick");
      return null;
    }
    if (err instanceof DailyLimitReachedError) {
      // Corrida rara: passou no decideTick mas o limite foi atingido por
      // outra execução entre a checagem e a tentativa - o pipeline já
      // barra isso sozinho, aqui só evitamos logar como erro de verdade.
      logger?.info("[scheduler] limite diário atingido, pulando este tick");
      return null;
    }
    logger?.error("[scheduler] erro inesperado durante execução automática", err);
    return null;
  }
}

/**
 * Inicia o cron do scheduler. Roda a cada minuto e delega toda a decisão
 * para `schedulerTick`/`decideTick`, que já respeitam intervalo, horário
 * de funcionamento e kill switch.
 */
export function startScheduler(deps: SchedulerDeps): cron.ScheduledTask {
  return cron.schedule("* * * * *", () => {
    schedulerTick(deps).catch((err) => {
      deps.logger?.error("[scheduler] falha não tratada no tick", err);
    });
  });
}
