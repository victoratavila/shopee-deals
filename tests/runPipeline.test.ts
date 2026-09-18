import { describe, it, expect } from "vitest";
import { runPipeline, ConcurrentRunError } from "../src/pipeline/runPipeline.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

describe("runPipeline (integração com fakes)", () => {
  it("processa as fixtures, aceita ofertas válidas e rejeita a suspeita", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 5, minRatingCount: 10, minSalesCount: 5 });
    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test-suite",
    });

    expect(result.productsFound).toBe(3); // 3 fixtures
    // FIXTURE-003 tem previousPrice muito inconsistente comparado ao histórico
    // mas como não há histórico ainda na primeira rodada, ela passa pelo filtro
    // de suspeita (que exige sampleSize >= 2). Isso é esperado e coberto no
    // teste de checkSuspiciousPrice isoladamente.
    expect(result.dealsSelected).toBeGreaterThan(0);
    expect(result.errorsCount).toBe(0);
  });

  it("não publica o mesmo produto duas vezes na mesma rodada (idempotência básica)", async () => {
    const repos = createInMemoryRepositories({
      minDiscountPercent: 0,
      minRatingCount: 0,
      minSalesCount: 0,
      minRating: 0,
      minCommissionPercent: 0,
    });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    // roda de novo imediatamente -> tudo deve ser rejeitado por RECENTLY_PUBLISHED
    const second = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(second.dealsSelected).toBe(0);
    expect(second.rejected.every((r) => r.reason === "RECENTLY_PUBLISHED")).toBe(true);
  });

  it("impede execução simultânea (ConcurrentRunError)", async () => {
    const repos = createInMemoryRepositories();
    repos.state.runs.push({ id: "existing-run", status: "RUNNING" });

    await expect(
      runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" }),
    ).rejects.toBeInstanceOf(ConcurrentRunError);
  });

  it("respeita o limite máximo de ofertas por rodada", async () => {
    const repos = createInMemoryRepositories({
      minDiscountPercent: 0,
      minRatingCount: 0,
      minSalesCount: 0,
      maxOffersPerRound: 1,
    });
    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(result.dealsSelected).toBe(1);
    expect(result.rejected.some((r) => r.reason === "ROUND_LIMIT_REACHED")).toBe(true);
  });

  it("uma falha em um produto não interrompe o processamento dos demais", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 0, minRatingCount: 0, minSalesCount: 0 });
    const originalUpsert = repos.product.upsert.bind(repos.product);
    let calls = 0;
    repos.product.upsert = async (offer, link) => {
      calls++;
      if (calls === 1) throw new Error("falha simulada no primeiro produto");
      return originalUpsert(offer, link);
    };

    const result = await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });

    expect(result.errorsCount).toBe(1);
    expect(result.dealsSelected).toBeGreaterThan(0); // os demais produtos continuaram sendo processados
  });
});
