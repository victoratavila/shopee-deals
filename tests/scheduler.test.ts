import { describe, it, expect } from "vitest";
import { decideTick, resolveEffectiveMode, isWithinOperatingHours } from "../src/scheduler/scheduler.js";

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
  it("janela normal (8h-22h)", () => {
    expect(isWithinOperatingHours(new Date(2026, 0, 1, 10, 0), 8, 22)).toBe(true);
    expect(isWithinOperatingHours(new Date(2026, 0, 1, 23, 0), 8, 22)).toBe(false);
  });
  it("janela que atravessa a meia-noite (22h-6h)", () => {
    expect(isWithinOperatingHours(new Date(2026, 0, 1, 23, 0), 22, 6)).toBe(true);
    expect(isWithinOperatingHours(new Date(2026, 0, 1, 3, 0), 22, 6)).toBe(true);
    expect(isWithinOperatingHours(new Date(2026, 0, 1, 12, 0), 22, 6)).toBe(false);
  });
});

describe("decideTick", () => {
  const base = {
    now: new Date(2026, 0, 1, 12, 0),
    automationEnabled: true,
    automationStartHour: 8,
    automationEndHour: 22,
    intervalBetweenRoundsMinutes: 60,
    lastRunFinishedAt: null as Date | null,
    hasActiveRun: false,
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
    expect(decideTick({ ...base, now: new Date(2026, 0, 1, 23, 0) }).shouldRun).toBe(false);
  });

  it("não roda se o intervalo mínimo entre rodadas não passou", () => {
    const lastRunFinishedAt = new Date(2026, 0, 1, 11, 30); // 30 min atrás, intervalo é 60
    expect(decideTick({ ...base, lastRunFinishedAt }).shouldRun).toBe(false);
  });

  it("roda se o intervalo mínimo já passou", () => {
    const lastRunFinishedAt = new Date(2026, 0, 1, 10, 0); // 2h atrás
    expect(decideTick({ ...base, lastRunFinishedAt }).shouldRun).toBe(true);
  });
});
