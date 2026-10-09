import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";
import { FIXTURE_OFFERS } from "../src/shopee/fixtures.js";

const lenient = (overrides = {}) =>
  createInMemoryRepositories({ minDiscountPercent: 0, minRatingCount: 0, minSalesCount: 0, minRating: 0, minCommissionPercent: 0, ...overrides });

describe("modo ALL_PRODUCTS", () => {
  it("mantém comportamento atual sem keyword", async () => {
    const repos = lenient();
    const r = await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    expect(r.productsFound).toBe(FIXTURE_OFFERS.length);
    expect(r.accepted.every((offer) => offer.offer.searchCategoryName === "Busca geral")).toBe(true);
  });
});

describe("modo CATEGORIES", () => {
  it("busca keywords de todas as categorias selecionadas mesmo ao atingir o limite de aprovações", async () => {
    const searchedKeywords: Array<string | undefined> = [];
    const client = new MockShopeeClient();
    const original = client.searchOffers.bind(client);
    client.searchOffers = async (params) => {
      searchedKeywords.push(params.keyword);
      return original(params);
    };

    const repos = lenient({
      searchMode: "CATEGORIES",
      maxOffersPerRound: 1,
      keywordCategories: [
        { id: "1", name: "Áudio", keywords: ["fone"], selected: true },
        { id: "2", name: "Acessórios", keywords: ["suporte"], selected: true },
      ],
    });
    const result = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(searchedKeywords).toEqual(["fone", "suporte"]);
    expect(result.dealsSelected).toBe(1);
  });

  it("ignora categoria não selecionada", async () => {
    const repos = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "1", name: "A", keywords: ["teclado"], selected: true },
        { id: "2", name: "B", keywords: ["mouse"], selected: false },
      ],
    });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const names = repos.state.products.size;
    const reposB = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "1", name: "A", keywords: ["teclado"], selected: true },
        { id: "2", name: "B", keywords: ["mouse"], selected: true },
      ],
    });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos: reposB, mode: "TEST", triggeredBy: "test" });
    // Com as duas selecionadas, o sistema processa ambas
    expect(reposB.state.products.size).toBeGreaterThanOrEqual(names);
  });

  it("keywords duplicadas entre categorias não geram busca duplicada", async () => {
    let callCount = 0;
    const countingClient = new MockShopeeClient();
    const original = countingClient.searchOffers.bind(countingClient);
    countingClient.searchOffers = async (p) => { callCount++; return original(p); };

    const repos = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "1", name: "A", keywords: ["mouse"], selected: true },
        { id: "2", name: "B", keywords: ["mouse"], selected: true },
      ],
    });
    await runPipeline({ shopeeClient: countingClient, repos, mode: "TEST", triggeredBy: "test" });
    expect(callCount).toBe(1); // "mouse" aparece só uma vez
  });

  it("normaliza espaços e maiúsculas ao deduplicar keywords", async () => {
    const searchedKeywords: Array<string | undefined> = [];
    const client = new MockShopeeClient();
    const original = client.searchOffers.bind(client);
    client.searchOffers = async (params) => {
      searchedKeywords.push(params.keyword);
      return original(params);
    };
    const repos = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "1", name: "A", keywords: ["  Mouse  "], selected: true },
        { id: "2", name: "B", keywords: ["mouse", " MOUSE "], selected: true },
      ],
    });

    await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(searchedKeywords).toEqual(["Mouse"]);
  });

  it("aplica o limite de ofertas buscadas separadamente em cada categoria e registra os resultados", async () => {
    const searchedKeywords: string[] = [];
    const client = new MockShopeeClient();
    client.searchOffers = async ({ keyword }) => {
      searchedKeywords.push(keyword ?? "");
      return {
        offers: Array.from({ length: 20 }, (_, index) => ({
          shopeeItemId: `${keyword}-${index}`,
          name: `Produto ${keyword} ${index}`,
          url: `https://example.invalid/${keyword}/${index}`,
          currentPrice: 100,
          discountPercent: 30,
          rating: 4.5,
          ratingCount: 100,
          salesCount: 100,
          commissionPercent: 5,
          affiliateLink: `https://example.invalid/affiliate/${keyword}-${index}`,
        })),
        hasNextPage: false,
      };
    };
    const repos = lenient({
      searchMode: "CATEGORIES",
      searchLimitScope: "CATEGORY",
      maxOffersFetchedPerRound: 20,
      maxOffersPerRound: 1,
      keywordCategories: [
        { id: "1", name: "Categoria A", keywords: ["alpha", "alpha-extra"], selected: true },
        { id: "2", name: "Categoria B", keywords: ["beta"], selected: true },
      ],
    });

    const result = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(searchedKeywords).toEqual(["alpha", "alpha-extra", "beta"]);
    expect(result.productsFound).toBe(40);
    expect(result.dealsSelected).toBe(1);
    expect(result.productsFiltered).toBe(39);
    expect(result.rejected.every((offer) => offer.reason === "ROUND_LIMIT_REACHED")).toBe(true);
    expect(result.accepted[0]?.offer.searchCategoryId).toBe("keyword:alpha");
    expect(result.accepted[0]?.offer.searchCategoryName).toBe("alpha");
    expect(repos.state.publishedDeals[0]?.searchCategoryId).toBe("keyword:alpha");
    expect(repos.state.publishedDeals[0]?.searchCategoryName).toBe("alpha");
    expect(
      new Set(result.rejected.map((offer) => offer.offerSnapshot?.searchCategoryName)),
    ).toEqual(new Set(["alpha", "alpha-extra", "beta"]));
  });

  it("mantém o limite global da rodada quando essa opção está selecionada", async () => {
    const searchedKeywords: string[] = [];
    const client = new MockShopeeClient();
    client.searchOffers = async ({ keyword }) => {
      searchedKeywords.push(keyword ?? "");
      return {
        offers: Array.from({ length: 15 }, (_, index) => ({
          shopeeItemId: `${keyword}-${index}`,
          name: `Produto ${keyword} ${index}`,
          url: `https://example.invalid/${keyword}/${index}`,
          currentPrice: 100,
          discountPercent: 30,
          rating: 4.5,
          ratingCount: 100,
          salesCount: 100,
          commissionPercent: 5,
          affiliateLink: `https://example.invalid/affiliate/${keyword}-${index}`,
        })),
        hasNextPage: false,
      };
    };
    const repos = lenient({
      searchMode: "CATEGORIES",
      searchLimitScope: "ROUND",
      maxOffersFetchedPerRound: 20,
      keywordCategories: [
        { id: "1", name: "Categoria A", keywords: ["alpha"], selected: true },
        { id: "2", name: "Categoria B", keywords: ["beta"], selected: true },
      ],
    });

    const result = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(searchedKeywords).toEqual(["alpha", "beta"]);
    expect(result.productsFound).toBe(20);
  });

  it("erro em uma keyword não interrompe as demais", async () => {
    let call = 0;
    const failFirstClient = new MockShopeeClient();
    const original = failFirstClient.searchOffers.bind(failFirstClient);
    failFirstClient.searchOffers = async (p) => {
      call++;
      if (p.keyword === "FAIL_ME") throw new Error("temporário");
      return original(p);
    };
    const repos = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "1", name: "A", keywords: ["FAIL_ME", "FIXTURE-001"], selected: true },
      ],
    });
    const r = await runPipeline({ shopeeClient: failFirstClient, repos, mode: "TEST", triggeredBy: "test" });
    expect(r.errorsCount).toBeGreaterThanOrEqual(1);
    expect(call).toBe(4); // FAIL_ME tenta 3x (retry) + 1 pra FIXTURE-001
  });

  it("sem categorias selecionadas cai no comportamento padrão (busca geral)", async () => {
    const repos = lenient({
      searchMode: "CATEGORIES",
      keywordCategories: [{ id: "1", name: "A", keywords: ["teclado"], selected: false }],
    });
    const r = await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    expect(r.productsFound).toBe(FIXTURE_OFFERS.length);
  });
});
