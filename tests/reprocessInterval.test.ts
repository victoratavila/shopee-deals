import { describe, expect, it } from "vitest";
import type { RawShopeeOffer } from "../src/types/domain.js";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

const offer: RawShopeeOffer = {
  shopeeItemId: "SHOPEE-ITEM-42",
  name: "Produto de teste",
  url: "https://example.invalid/product/42",
  currentPrice: 100,
  discountPercent: 10,
  rating: 4.8,
  ratingCount: 500,
  salesCount: 1_000,
  commissionPercent: 5,
  affiliateLink: "https://example.invalid/affiliate/42",
};

function clientWithOffer(getOffer: () => RawShopeeOffer): MockShopeeClient {
  const client = new MockShopeeClient();
  client.searchOffers = async () => ({ offers: [getOffer()], hasNextPage: false });
  return client;
}

const permissiveSettings = {
  minDiscountPercent: 0,
  minRating: 0,
  minRatingCount: 0,
  minSalesCount: 0,
  minCommissionPercent: 0,
  republishIntervalMinutes: null,
  reprocessIntervalMinutes: 1_440,
};

describe("intervalo para reprocessar produtos identificados", () => {
  it("não cria rejeições repetidas para um produto já rejeitado dentro do intervalo", async () => {
    const repos = createInMemoryRepositories({
      ...permissiveSettings,
      minDiscountPercent: 30,
    });
    const client = clientWithOffer(() => offer);

    const first = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });
    const second = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(first.productsFiltered).toBe(1);
    expect(repos.state.rejected).toHaveLength(1);
    expect(second.productsFound).toBe(1);
    expect(second.productsFiltered).toBe(0);
    expect(second.rejected).toHaveLength(0);
    expect(repos.state.rejected).toHaveLength(1);
  });

  it("reavalia a oferta após o intervalo, pode aprová-la e preserva a rejeição anterior", async () => {
    const repos = createInMemoryRepositories({
      ...permissiveSettings,
      minDiscountPercent: 30,
    });
    let currentOffer = offer;
    const client = clientWithOffer(() => currentOffer);

    await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });
    repos.state.rejected[0]!.createdAt = new Date(Date.now() - 1_441 * 60_000);
    currentOffer = { ...offer, discountPercent: 50, currentPrice: 50 };

    const retry = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(retry.dealsSelected).toBe(1);
    expect(retry.rejected).toHaveLength(0);
    expect(repos.state.rejected).toHaveLength(1);
    expect(repos.state.products.size).toBe(1);
    expect(repos.state.publishedDeals).toHaveLength(1);
  });

  it("usa Product para pular produto aprovado durante o intervalo", async () => {
    const repos = createInMemoryRepositories(permissiveSettings);
    const client = clientWithOffer(() => offer);

    await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });
    const second = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(second.productsFiltered).toBe(0);
    expect(second.rejected).toHaveLength(0);
    expect(repos.state.publishedDeals).toHaveLength(1);
  });

  it("não processa duas vezes o mesmo ID encontrado por buscas diferentes na rodada", async () => {
    const repos = createInMemoryRepositories({
      ...permissiveSettings,
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "a", name: "A", keywords: ["alpha"], selected: true },
        { id: "b", name: "B", keywords: ["beta"], selected: true },
      ],
    });
    const client = clientWithOffer(() => offer);

    const result = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(result.productsFound).toBe(2);
    expect(result.dealsSelected).toBe(1);
    expect(result.productsFiltered).toBe(0);
    expect(repos.state.rejected).toHaveLength(0);
  });

  it("considera expirado o intervalo no seu limite exato", async () => {
    const repos = createInMemoryRepositories({
      ...permissiveSettings,
      minDiscountPercent: 30,
    });
    const client = clientWithOffer(() => offer);
    await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });
    repos.state.rejected[0]!.createdAt = new Date(Date.now() - 1_440 * 60_000 - 5_000);

    const retry = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(retry.productsFiltered).toBe(1);
    expect(repos.state.rejected).toHaveLength(2);
  });
});
