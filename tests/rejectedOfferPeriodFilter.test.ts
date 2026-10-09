import { describe, it, expect } from "vitest";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

describe("RejectedOfferRepository.listRecent com filtro de período", () => {
  function seedRejection(repos: ReturnType<typeof createInMemoryRepositories>, id: string, createdAt: Date) {
    repos.state.rejected.push({
      id,
      shopeeItemId: `ITEM-${id}`,
      productName: `Produto ${id}`,
      reason: "DISCOUNT_BELOW_MINIMUM",
      details: null,
      offerSnapshot: JSON.stringify({
        shopeeItemId: `ITEM-${id}`,
        name: `Produto ${id}`,
        url: "https://example.invalid",
        currentPrice: 10,
      }),
      manuallyApprovedAt: null,
      manuallyApprovedBy: null,
      createdAt,
    });
  }

  it("'hoje' retorna somente rejeições da data atual", async () => {
    const repos = createInMemoryRepositories();
    seedRejection(repos, "today-morning", new Date(2026, 8, 20, 8, 0, 0));
    seedRejection(repos, "today-night", new Date(2026, 8, 20, 23, 59, 59));
    seedRejection(repos, "yesterday", new Date(2026, 8, 19, 23, 59, 59));

    const since = new Date(2026, 8, 20, 0, 0, 0, 0); // início de hoje (20/09)
    const results = await repos.rejectedOffer.listRecent(100, since);

    expect(results.map((r) => r.id).sort()).toEqual(["today-morning", "today-night"]);
  });

  it("'últimos 3 dias' retorna exatamente hoje + os 2 dias anteriores", async () => {
    const repos = createInMemoryRepositories();
    // hoje = 20/09/2026
    seedRejection(repos, "d20", new Date(2026, 8, 20, 12, 0, 0));
    seedRejection(repos, "d19", new Date(2026, 8, 19, 12, 0, 0));
    seedRejection(repos, "d18-cedo", new Date(2026, 8, 18, 0, 0, 1));
    seedRejection(repos, "d17", new Date(2026, 8, 17, 23, 59, 59)); // fora do período

    const since = new Date(2026, 8, 18, 0, 0, 0, 0); // início de 18/09 (hoje - 2 dias)
    const results = await repos.rejectedOffer.listRecent(100, since);

    expect(results.map((r) => r.id).sort()).toEqual(["d18-cedo", "d19", "d20"]);
  });

  it("uma rejeição anterior ao período não aparece", async () => {
    const repos = createInMemoryRepositories();
    seedRejection(repos, "dentro", new Date(2026, 8, 18, 0, 0, 0));
    seedRejection(repos, "fora", new Date(2026, 8, 17, 23, 59, 59, 999)); // 1ms antes do corte

    const since = new Date(2026, 8, 18, 0, 0, 0, 0);
    const results = await repos.rejectedOffer.listRecent(100, since);

    expect(results.map((r) => r.id)).toEqual(["dentro"]);
  });

  it("limites de início/fim do dia funcionam corretamente (borda exata incluída, 1ms antes excluída)", async () => {
    const repos = createInMemoryRepositories();
    const cutoff = new Date(2026, 8, 18, 0, 0, 0, 0);
    seedRejection(repos, "exatamente-no-corte", cutoff);
    seedRejection(repos, "um-ms-antes", new Date(cutoff.getTime() - 1));

    const results = await repos.rejectedOffer.listRecent(100, cutoff);

    expect(results.map((r) => r.id)).toEqual(["exatamente-no-corte"]);
  });

  it("sem 'since' informado, mantém o comportamento anterior (sem filtro de data)", async () => {
    const repos = createInMemoryRepositories();
    seedRejection(repos, "antigo", new Date(2020, 0, 1));
    seedRejection(repos, "recente", new Date());

    const results = await repos.rejectedOffer.listRecent(100);

    expect(results.map((r) => r.id).sort()).toEqual(["antigo", "recente"]);
  });

  it("o filtro de período é só leitura: não altera os dados nem o status das ofertas", async () => {
    const repos = createInMemoryRepositories();
    seedRejection(repos, "r1", new Date(2026, 8, 20));
    const before = JSON.stringify(repos.state.rejected);

    await repos.rejectedOffer.listRecent(100, new Date(2026, 8, 20));
    await repos.rejectedOffer.listRecent(100, new Date(2020, 0, 1));

    expect(JSON.stringify(repos.state.rejected)).toBe(before);
  });
});
