import { describe, it, expect } from "vitest";
import { startOfDaysAgo, clampPeriodDays, MAX_REJECTIONS_PERIOD_DAYS } from "../src/utils/dateRange.js";

describe("clampPeriodDays - impõe o limite máximo no backend", () => {
  it("aceita 1 (hoje) e 3 (últimos 3 dias) sem alterar", () => {
    expect(clampPeriodDays(1)).toBe(1);
    expect(clampPeriodDays(3)).toBe(3);
  });

  it("reduz qualquer pedido acima do máximo para o máximo (3)", () => {
    expect(clampPeriodDays(7)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(30)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(9999)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
  });

  it("valores ausentes, inválidos ou não-positivos caem no máximo permitido, não em 'sem filtro'", () => {
    expect(clampPeriodDays(undefined)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(0)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(-5)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(1.5)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
    expect(clampPeriodDays(NaN)).toBe(MAX_REJECTIONS_PERIOD_DAYS);
  });
});

describe("startOfDaysAgo", () => {
  it("daysAgo=1 (hoje) retorna o início do próprio dia", () => {
    const now = new Date(2026, 8, 20, 15, 30, 0); // 20/09/2026 15:30
    const result = startOfDaysAgo(1, now);
    expect(result).toEqual(new Date(2026, 8, 20, 0, 0, 0, 0));
  });

  it("daysAgo=3 (últimos 3 dias) inclui hoje + 2 dias anteriores, não uma janela de 72h", () => {
    const now = new Date(2026, 8, 20, 23, 59, 0); // 20/09/2026 23:59 - próximo da virada
    const result = startOfDaysAgo(3, now);
    // Deve ser 18/09/2026 00:00:00, não "72h atrás" (que seria 17/09 23:59).
    expect(result).toEqual(new Date(2026, 8, 18, 0, 0, 0, 0));
  });

  it("daysAgo=7 (últimos 7 dias) inclui hoje + 6 dias anteriores", () => {
    const now = new Date(2026, 8, 20, 10, 0, 0);
    const result = startOfDaysAgo(7, now);
    expect(result).toEqual(new Date(2026, 8, 14, 0, 0, 0, 0));
  });

  it("funciona corretamente atravessando a virada de mês", () => {
    const now = new Date(2026, 9, 1, 12, 0, 0); // 01/10/2026
    const result = startOfDaysAgo(3, now);
    expect(result).toEqual(new Date(2026, 8, 29, 0, 0, 0, 0)); // 29/09/2026
  });

  it("é insensível ao horário do momento em que é chamado (só à data de calendário)", () => {
    const cedo = new Date(2026, 8, 20, 0, 0, 1);
    const tarde = new Date(2026, 8, 20, 23, 59, 59);
    expect(startOfDaysAgo(3, cedo)).toEqual(startOfDaysAgo(3, tarde));
  });
});
