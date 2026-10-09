import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { FIXTURE_OFFERS } from "../src/shopee/fixtures.js";
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

describe("maxOffersFetchedPerRound - teto de ofertas buscadas na Shopee, antes de qualquer filtro", () => {
  it("limita quantas ofertas são buscadas/avaliadas, mesmo que existam mais disponíveis", async () => {
    const repos = lenientRepos({ maxOffersFetchedPerRound: 2 });
    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    // As fixtures têm 3 produtos, mas o teto é 2 - o terceiro nem é buscado.
    expect(result.productsFound).toBe(2);
    expect(result.accepted.length + result.productsFiltered).toBeLessThanOrEqual(2);
  });

  it("o produto que ficou de fora do teto não é gravado no banco (nem aceito, nem rejeitado)", async () => {
    const repos = lenientRepos({ maxOffersFetchedPerRound: 2 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    const lastFixtureId = FIXTURE_OFFERS[FIXTURE_OFFERS.length - 1]!.shopeeItemId;
    expect(await repos.product.findByShopeeItemId(lastFixtureId)).toBeNull();
    expect(repos.state.rejected.some((r) => r.shopeeItemId === lastFixtureId)).toBe(false);
  });

  it("null (sem limite) preserva o comportamento anterior - busca todas as ofertas disponíveis", async () => {
    const repos = lenientRepos({ maxOffersFetchedPerRound: null });
    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(result.productsFound).toBe(FIXTURE_OFFERS.length);
  });

  it("é independente do teto de ofertas APROVADAS (maxOffersPerRound) - controlam coisas diferentes", async () => {
    // Busca no máximo 3 (não limita), mas só aprova no máximo 1.
    const repos = lenientRepos({ maxOffersFetchedPerRound: 3, maxOffersPerRound: 1 });
    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(result.dealsSelected).toBe(1);
    // Mas as ofertas buscadas/avaliadas podem ser menos que 3, já que o
    // processamento para assim que a rodada de aprovação enche (isso já
    // era o comportamento existente, não mudou).
    expect(result.productsFound).toBeGreaterThanOrEqual(1);
  });
});
