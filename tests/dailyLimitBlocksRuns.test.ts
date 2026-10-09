import { describe, it, expect } from "vitest";
import { runPipeline, DailyLimitReachedError } from "../src/pipeline/runPipeline.js";
import { isDailyLimitReached } from "../src/pipeline/dailyLimit.js";
import { decideTick } from "../src/scheduler/scheduler.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

function lenientRepos(overrides = {}) {
  return createInMemoryRepositories({
    minDiscountPercent: 0,
    minRatingCount: 0,
    minSalesCount: 0,
    minRating: 0,
    minCommissionPercent: 0,
    ...overrides,
  });
}

describe("limite diário bloqueia a execução inteira (não rejeita oferta por oferta)", () => {
  it("uma vez atingido o limite, runPipeline lança DailyLimitReachedError e NÃO cria um novo Run", async () => {
    const repos = lenientRepos({ maxOffersPerDay: 1 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    // A primeira rodada já publicou pelo menos 1 oferta em TEST, atingindo o limite.

    const runsBefore = repos.state.runs.length;
    await expect(
      runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" }),
    ).rejects.toBeInstanceOf(DailyLimitReachedError);

    // Nenhum Run novo foi criado para a tentativa bloqueada.
    expect(repos.state.runs.length).toBe(runsBefore);
  });

  it("o motivo DAILY_LIMIT_REACHED não é mais usado para rejeitar ofertas individuais", async () => {
    const repos = lenientRepos({ maxOffersPerDay: 1 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    // A segunda tentativa é bloqueada antes de processar qualquer oferta -
    // não gera nenhuma linha de rejeição nova.
    const rejectedBefore = repos.state.rejected.length;
    await expect(
      runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" }),
    ).rejects.toBeInstanceOf(DailyLimitReachedError);
    expect(repos.state.rejected.length).toBe(rejectedBefore);
    expect(repos.state.rejected.some((r) => r.reason === "DAILY_LIMIT_REACHED")).toBe(false);
  });

  it("a contagem é por canal - TEST não consome o limite de DRY_RUN nem vice-versa", async () => {
    const repos = lenientRepos({ maxOffersPerDay: 1 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    // O limite de TEST foi atingido, mas DRY_RUN é um canal diferente -
    // não deveria estar bloqueado por causa do que aconteceu em TEST.
    const settings = await repos.settings.getOperationalSettings();
    const reachedForTest = await isDailyLimitReached(repos, settings, "TEST");
    const reachedForDryRun = await isDailyLimitReached(repos, settings, "DRY_RUN");
    expect(reachedForTest).toBe(true);
    expect(reachedForDryRun).toBe(false);
  });

  it("com maxOffersPerDay null (sem limite), nunca bloqueia", async () => {
    const repos = lenientRepos({ maxOffersPerDay: null });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    await expect(
      runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" }),
    ).resolves.toBeDefined();
  });

  it("decideTick não roda o scheduler quando o limite diário foi atingido", () => {
    const base = {
      now: new Date(2026, 0, 1, 12, 0),
      automationEnabled: true,
      automationStartHour: 8,
      automationEndHour: 22,
      intervalBetweenRoundsMinutes: 60,
      lastRunFinishedAt: null,
      hasActiveRun: false,
      dailyLimitReached: false,
    };
    expect(decideTick(base).shouldRun).toBe(true);
    expect(decideTick({ ...base, dailyLimitReached: true }).shouldRun).toBe(false);
    expect(decideTick({ ...base, dailyLimitReached: true }).reason).toMatch(/limite di[aá]rio/i);
  });
});
