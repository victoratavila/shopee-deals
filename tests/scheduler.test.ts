import { describe, it, expect } from "vitest";
import {
  decideTick,
  resolveEffectiveMode,
  isWithinOperatingHours,
  getNextScheduledTickAt,
  getLatestSchedulerAnchor,
} from "../src/scheduler/scheduler.js";

describe("resolveEffectiveMode", () => {
  it("força TEST quando o ambiente está em TEST, mesmo com dryRun desligado", () => {
    expect(resolveEffectiveMode("TEST", false)).toBe("TEST");
  });
  it("usa DRY_RUN quando dryRunEnabled é true", () => {
    expect(resolveEffectiveMode("PRODUCTION", true)).toBe("DRY_RUN");
  });
  it("usa PRODUCTION quando dryRunEnabled é false", () => {
    expect(resolveEffectiveMode("PRODUCTION", false)).toBe("PRODUCTION");
  });
});

describe("isWithinOperatingHours", () => {
  it("janela normal no fuso configurado", () => {
    expect(isWithinOperatingHours(new Date("2026-01-01T15:00:00Z"), "08:00", "22:00", "America/Sao_Paulo")).toBe(true);
    expect(isWithinOperatingHours(new Date("2026-01-01T02:00:00Z"), "08:00", "22:00", "America/Sao_Paulo")).toBe(false);
  });
  it("janela que atravessa a meia-noite no fuso configurado", () => {
    expect(isWithinOperatingHours(new Date("2026-01-02T02:00:00Z"), "22:00", "06:00", "America/Sao_Paulo")).toBe(true);
    expect(isWithinOperatingHours(new Date("2026-01-01T12:00:00Z"), "22:00", "06:00", "America/Sao_Paulo")).toBe(false);
  });
  it("considera intervalos horários no fuso selecionado, não no timezone do servidor", () => {
    expect(isWithinOperatingHours(new Date("2026-01-01T12:00:00Z"), "08:00", "18:00", "America/Sao_Paulo")).toBe(true);
    expect(isWithinOperatingHours(new Date("2026-01-01T12:00:00Z"), "08:00", "18:00", "Asia/Tokyo")).toBe(false);
  });
});

describe("decideTick", () => {
  const base = {
    now: new Date("2026-01-01T15:00:00Z"),
    automationEnabled: true,
    operatingHoursEnabled: true,
    automationStartTime: "08:00",
    automationEndTime: "22:00",
    automationTimeZone: "America/Sao_Paulo",
    intervalBetweenRoundsMinutes: 60,
    lastRunFinishedAt: null as Date | null,
    hasActiveRun: false,
    dailyLimitReached: false,
  };

  it("roda quando todas as condições são satisfeitas", () => {
    expect(decideTick(base).shouldRun).toBe(true);
  });

  it("não roda se a automação está desativada (kill switch)", () => {
    expect(decideTick({ ...base, automationEnabled: false }).shouldRun).toBe(false);
  });

  it("não roda se já existe uma execução em andamento", () => {
    expect(decideTick({ ...base, hasActiveRun: true }).shouldRun).toBe(false);
  });

  it("não roda fora do horário de funcionamento", () => {
    expect(decideTick({ ...base, now: new Date("2026-01-02T02:00:00Z") }).shouldRun).toBe(false);
  });

  it("não roda se o intervalo mínimo entre rodadas não passou", () => {
    const lastRunFinishedAt = new Date("2026-01-01T14:30:00Z"); // 30 min atrás, intervalo é 60
    expect(decideTick({ ...base, lastRunFinishedAt }).shouldRun).toBe(false);
  });

  it("roda se o intervalo mínimo já passou", () => {
    const lastRunFinishedAt = new Date("2026-01-01T13:00:00Z"); // 2h atrás
    expect(decideTick({ ...base, lastRunFinishedAt }).shouldRun).toBe(true);
  });

  it("ignora a janela quando ela está desativada", () => {
    expect(
      decideTick({
        ...base,
        now: new Date("2026-01-01T02:00:00Z"),
        operatingHoursEnabled: false,
      }).shouldRun,
    ).toBe(true);
  });
});

describe("getNextScheduledTickAt", () => {
  const base = {
    now: new Date("2026-01-01T12:00:30Z"),
    automationEnabled: true,
    operatingHoursEnabled: true,
    automationStartTime: "08:00",
    automationEndTime: "22:00",
    automationTimeZone: "America/Sao_Paulo",
    intervalBetweenRoundsMinutes: 60,
    lastRunFinishedAt: null as Date | null,
    hasActiveRun: false,
    dailyLimitReached: false,
  };

  it("retorna o próximo segundo elegível do cron", () => {
    expect(getNextScheduledTickAt(base)).toEqual(new Date("2026-01-01T12:00:31Z"));
  });

  it("respeita o intervalo exato e arredonda somente para o próximo segundo", () => {
    const lastRunFinishedAt = new Date("2026-01-01T11:30:30Z");
    expect(getNextScheduledTickAt({ ...base, lastRunFinishedAt })).toEqual(
      new Date("2026-01-01T12:30:30Z"),
    );
  });

  it("aguarda a abertura da janela no timezone escolhido", () => {
    expect(
      getNextScheduledTickAt({
        ...base,
        now: new Date("2026-01-02T01:30:00Z"),
      }),
    ).toEqual(new Date("2026-01-02T11:00:00Z"));
  });

  it("não aguarda a janela quando o controle está desativado", () => {
    expect(
      getNextScheduledTickAt({
        ...base,
        now: new Date("2026-01-01T02:00:00Z"),
        operatingHoursEnabled: false,
      }),
    ).toEqual(new Date("2026-01-01T02:00:01Z"));
  });

  it("retorna null se pausado, ocupado ou bloqueado pelo limite diário", () => {
    expect(getNextScheduledTickAt({ ...base, automationEnabled: false })).toBeNull();
    expect(getNextScheduledTickAt({ ...base, hasActiveRun: true })).toBeNull();
    expect(getNextScheduledTickAt({ ...base, dailyLimitReached: true })).toBeNull();
  });
});

describe("getLatestSchedulerAnchor", () => {
  it("usa o momento mais recente entre término, retomada e atualização da página", () => {
    const finishedAt = new Date("2026-01-01T12:00:00Z");
    expect(
      getLatestSchedulerAnchor(
        finishedAt,
        "2026-01-01T12:05:00.000Z",
        "2026-01-01T12:07:00.000Z",
      ),
    ).toEqual(new Date("2026-01-01T12:07:00Z"));
    expect(getLatestSchedulerAnchor(finishedAt, "2026-01-01T11:55:00.000Z")).toBe(finishedAt);
  });

  it("usa a retomada como referência quando ainda não há execução concluída", () => {
    expect(getLatestSchedulerAnchor(null, "2026-01-01T12:05:00.000Z")).toEqual(
      new Date("2026-01-01T12:05:00Z"),
    );
    expect(getLatestSchedulerAnchor(null, null)).toBeNull();
  });

  it("reinicia o intervalo completo após a atualização das ofertas no painel", () => {
    const refreshCompletedAt = "2026-01-01T12:05:23.000Z";
    const anchor = getLatestSchedulerAnchor(
      new Date("2026-01-01T11:00:00Z"),
      null,
      refreshCompletedAt,
    );
    expect(
      getNextScheduledTickAt({
        now: new Date(refreshCompletedAt),
        automationEnabled: true,
        operatingHoursEnabled: false,
        automationStartTime: "08:00",
        automationEndTime: "22:00",
        automationTimeZone: "America/Sao_Paulo",
        intervalBetweenRoundsMinutes: 1,
        lastRunFinishedAt: anchor,
        hasActiveRun: false,
        dailyLimitReached: false,
      }),
    ).toEqual(new Date("2026-01-01T12:06:23.000Z"));
  });
});
