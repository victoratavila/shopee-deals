import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import type { Repositories } from "../db/repositories.js";
import type { RunMode } from "../types/domain.js";
import { runPipeline, ConcurrentRunError, DailyLimitReachedError, type PipelineResult } from "../pipeline/runPipeline.js";
import { isDailyLimitReached } from "../pipeline/dailyLimit.js";
import { notifySchedulerRunFinished } from "./runEvents.js";

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

function getMinuteOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

/** Verifica a janela de funcionamento no fuso horário configurado. */
export function isWithinOperatingHours(
  now: Date,
  startTime: string,
  endTime: string,
  timeZone: string,
): boolean {
  const currentMinute = getMinuteOfDay(now, timeZone);
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;

  if (start === end) return true;
  if (start < end) return currentMinute >= start && currentMinute < end;
  return currentMinute >= start || currentMinute < end;
}

export function getLatestSchedulerAnchor(
  lastRunFinishedAt: Date | null,
  automationResumeAt: string | null,
  schedulerRefreshAt: string | null = null,
): Date | null {
  const resumedAt = automationResumeAt === null ? null : new Date(automationResumeAt);
  const refreshedAt = schedulerRefreshAt === null ? null : new Date(schedulerRefreshAt);
  const anchors = [lastRunFinishedAt, resumedAt, refreshedAt].filter(
    (anchor): anchor is Date => anchor !== null,
  );
  return anchors.reduce<Date | null>(
    (latest, anchor) => (latest === null || anchor > latest ? anchor : latest),
    null,
  );
}

/**
 * Calculates the first upcoming cron second at which the scheduler can start
 * a run, based on its configured interval and operating window.
 */
export function getNextScheduledTickAt(params: {
  now: Date;
  automationEnabled: boolean;
  operatingHoursEnabled: boolean;
  automationStartTime: string;
  automationEndTime: string;
  automationTimeZone: string;
  intervalBetweenRoundsMinutes: number;
  lastRunFinishedAt: Date | null;
  hasActiveRun: boolean;
  dailyLimitReached: boolean;
}): Date | null {
  if (!params.automationEnabled || params.hasActiveRun || params.dailyLimitReached) {
    return null;
  }

  let candidate = Math.floor(params.now.getTime() / 1_000) * 1_000 + 1_000;
  if (params.lastRunFinishedAt !== null) {
    const intervalEnd =
      params.lastRunFinishedAt.getTime() + params.intervalBetweenRoundsMinutes * 60_000;
    candidate = Math.max(candidate, Math.ceil(intervalEnd / 1_000) * 1_000);
  }

  if (!params.operatingHoursEnabled) return new Date(candidate);
  if (
    isWithinOperatingHours(
      new Date(candidate),
      params.automationStartTime,
      params.automationEndTime,
      params.automationTimeZone,
    )
  ) {
    return new Date(candidate);
  }

  const initialCandidate = candidate;
  const maxChecks = 8 * 24 * 60;
  for (let minute = 0; minute < maxChecks; minute++, candidate += 60_000) {
    if (
      isWithinOperatingHours(
        new Date(candidate),
        params.automationStartTime,
        params.automationEndTime,
        params.automationTimeZone,
      )
    ) {
      const windowMinuteStart = Math.floor(candidate / 60_000) * 60_000;
      return new Date(Math.max(windowMinuteStart, initialCandidate));
    }
  }

  return null;
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
  operatingHoursEnabled: boolean;
  automationStartTime: string;
  automationEndTime: string;
  automationTimeZone: string;
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
  if (
    params.operatingHoursEnabled &&
    !isWithinOperatingHours(
      params.now,
      params.automationStartTime,
      params.automationEndTime,
      params.automationTimeZone,
    )
  ) {
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
  const lastRunFinishedAt = getLatestSchedulerAnchor(
    await repos.run.getLastFinishedAt(),
    settings.automationResumeAt,
    settings.schedulerRefreshAt,
  );
  const mode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
  const dailyLimitReached = await isDailyLimitReached(repos, settings, mode);

  const decision = decideTick({
    now: new Date(),
    automationEnabled: settings.automationEnabled,
    operatingHoursEnabled: settings.operatingHoursEnabled,
    automationStartTime: settings.automationStartTime,
    automationEndTime: settings.automationEndTime,
    automationTimeZone: settings.automationTimeZone,
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
    notifySchedulerRunFinished({ runId: result.runId, finishedAt: new Date().toISOString() });
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
 * Agenda a próxima execução com um timer dinâmico e revalida configurações
 * no máximo a cada 15 segundos. Assim, a execução pode respeitar o instante
 * devido sem consultar repetidamente o banco a cada segundo.
 */
export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  const maxRecheckDelayMs = 15_000;
  let stopped = false;
  let checkInProgress = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleCheck = (delayMs: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void checkAndSchedule();
    }, Math.max(0, delayMs));
  };

  const checkAndSchedule = async () => {
    if (stopped || checkInProgress) return;
    checkInProgress = true;
    let nextDelayMs = maxRecheckDelayMs;

    try {
      const { repos, envRunMode } = deps;
      const settings = await repos.settings.getOperationalSettings();
      const hasActiveRun = await repos.run.hasActiveRun();
      const lastRunFinishedAt = getLatestSchedulerAnchor(
        await repos.run.getLastFinishedAt(),
        settings.automationResumeAt,
        settings.schedulerRefreshAt,
      );
      const mode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
      const dailyLimitReached = await isDailyLimitReached(repos, settings, mode);
      const now = new Date();
      const decision = decideTick({
        now,
        automationEnabled: settings.automationEnabled,
        operatingHoursEnabled: settings.operatingHoursEnabled,
        automationStartTime: settings.automationStartTime,
        automationEndTime: settings.automationEndTime,
        automationTimeZone: settings.automationTimeZone,
        intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
        lastRunFinishedAt,
        hasActiveRun,
        dailyLimitReached,
      });
      const nextRunAt = getNextScheduledTickAt({
        now,
        automationEnabled: settings.automationEnabled,
        operatingHoursEnabled: settings.operatingHoursEnabled,
        automationStartTime: settings.automationStartTime,
        automationEndTime: settings.automationEndTime,
        automationTimeZone: settings.automationTimeZone,
        intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
        lastRunFinishedAt,
        hasActiveRun,
        dailyLimitReached,
      });

      if (decision.shouldRun) {
        await schedulerTick(deps);
        nextDelayMs = maxRecheckDelayMs;
      } else if (nextRunAt !== null) {
        nextDelayMs = Math.min(maxRecheckDelayMs, Math.max(0, nextRunAt.getTime() - now.getTime()));
      }
    } catch (err) {
      deps.logger?.error("[scheduler] falha ao calcular a próxima execução", err);
    } finally {
      checkInProgress = false;
      scheduleCheck(nextDelayMs);
    }
  };

  void checkAndSchedule();
  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
