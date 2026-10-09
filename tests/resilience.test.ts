import { describe, it, expect, vi } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { ShopeeApiError, type ShopeeClient, type SearchOffersResult } from "../src/shopee/ShopeeClient.js";
import { FIXTURE_OFFERS } from "../src/shopee/fixtures.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

function lenientRepos() {
  return createInMemoryRepositories({
    minDiscountPercent: 0,
    minRatingCount: 0,
    minSalesCount: 0,
    minRating: 0,
    minCommissionPercent: 0,
  });
}

/** Client fake que falha algumas vezes antes de ter sucesso (simula instabilidade de rede/API). */
function makeFlakyClient(failTimes: number, errorFactory: () => Error): ShopeeClient {
  let attempts = 0;
  return {
    async searchOffers(): Promise<SearchOffersResult> {
      attempts++;
      if (attempts <= failTimes) throw errorFactory();
      return { offers: FIXTURE_OFFERS, hasNextPage: false };
    },
    async getAffiliateLink(id: string) {
      return `https://example.invalid/affiliate/${id}`;
    },
  };
}

describe("resiliência - retry e timeout na busca", () => {
  it("recupera de falhas transitórias (rate limit) via retry", async () => {
    const client = makeFlakyClient(2, () => new ShopeeApiError("rate limited", "RATE_LIMIT", true));
    const repos = lenientRepos();

    const result = await runPipeline({
      shopeeClient: client,
      repos,
      mode: "TEST",
      triggeredBy: "test",
      shopeeMaxAttempts: 3,
    });

    expect(result.productsFound).toBe(FIXTURE_OFFERS.length);
    expect(result.errorsCount).toBe(0);
  });

  it("desiste após esgotar as tentativas e registra o erro sem travar a run", async () => {
    const client = makeFlakyClient(10, () => new ShopeeApiError("indisponível", "TIMEOUT", true));
    const repos = lenientRepos();

    const result = await runPipeline({
      shopeeClient: client,
      repos,
      mode: "TEST",
      triggeredBy: "test",
      shopeeMaxAttempts: 2,
    });

    expect(result.productsFound).toBe(0);
    expect(result.errorsCount).toBe(1);
    expect(repos.state.errors.length).toBe(1);
  });

  it("não tenta de novo um erro não-retryable (ex: credenciais inválidas)", async () => {
    let attempts = 0;
    const client: ShopeeClient = {
      async searchOffers() {
        attempts++;
        throw new ShopeeApiError("credenciais inválidas", "AUTH", false);
      },
      async getAffiliateLink(id: string) {
        return `https://example.invalid/affiliate/${id}`;
      },
    };
    const repos = lenientRepos();

    await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test", shopeeMaxAttempts: 5 });

    expect(attempts).toBe(1); // não retentou, pois retryable=false
  });

  it("aborta uma chamada que trava além do timeout configurado", async () => {
    const client: ShopeeClient = {
      async searchOffers() {
        await new Promise((resolve) => setTimeout(resolve, 500)); // "trava"
        return { offers: [], hasNextPage: false };
      },
      async getAffiliateLink(id: string) {
        return `https://example.invalid/affiliate/${id}`;
      },
    };
    const repos = lenientRepos();

    const result = await runPipeline({
      shopeeClient: client,
      repos,
      mode: "TEST",
      triggeredBy: "test",
      shopeeTimeoutMs: 50,
      shopeeMaxAttempts: 1,
    });

    expect(result.errorsCount).toBe(1);
  });

  it("dados inesperados/incompletos da API são rejeitados como INVALID_DATA, não travam a run", async () => {
    const client: ShopeeClient = {
      async searchOffers() {
        return {
          offers: [
            { shopeeItemId: "BROKEN-1", name: "", url: "", currentPrice: -5 },
          ],
          hasNextPage: false,
        };
      },
      async getAffiliateLink(id: string) {
        return `https://example.invalid/affiliate/${id}`;
      },
    };
    const repos = lenientRepos();

    const result = await runPipeline({ shopeeClient: client, repos, mode: "TEST", triggeredBy: "test" });

    expect(result.dealsSelected).toBe(0);
    expect(result.rejected[0]?.reason).toBe("INVALID_DATA");
    expect(result.errorsCount).toBe(0); // dado inválido é rejeição de negócio, não erro técnico
  });
});

describe("resiliência - banco de dados indisponível", () => {
  it("uma falha do banco ao processar um produto específico não derruba a rodada inteira", async () => {
    const repos = lenientRepos();
    const originalUpsert = repos.product.upsert.bind(repos.product);
    repos.product.upsert = vi.fn().mockImplementationOnce(() => {
      throw new Error("banco indisponível");
    }).mockImplementation(originalUpsert);

    const result = await runPipeline({
      shopeeClient: {
        async searchOffers() {
          return { offers: FIXTURE_OFFERS, hasNextPage: false };
        },
        async getAffiliateLink(id: string) {
          return `https://example.invalid/affiliate/${id}`;
        },
      },
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(result.errorsCount).toBe(1);
    expect(result.dealsSelected).toBeGreaterThan(0);
  });
});

describe("resiliência - reinicialização/recuperação", () => {
  it("reconcileStaleRuns libera o sistema para novas execuções após um crash", async () => {
    const repos = lenientRepos();
    repos.state.runs.push({ id: "stuck-run", status: "RUNNING", triggeredBy: "test", startedAt: new Date() });

    expect(await repos.run.hasActiveRun()).toBe(true);
    const recovered = await repos.run.reconcileStaleRuns(60);
    expect(recovered).toBe(1);
    expect(await repos.run.hasActiveRun()).toBe(false);
  });
});
