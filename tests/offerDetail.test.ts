import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { approveRejectedOfferManually } from "../src/pipeline/approveRejectedOffer.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

describe("dados completos para o modal de detalhes", () => {
  it("PublishedDeal.findById traz todos os campos do produto associado (não só o resumo)", async () => {
    const repos = createInMemoryRepositories({
      minDiscountPercent: 0,
      minRatingCount: 0,
      minSalesCount: 0,
      minRating: 0,
      minCommissionPercent: 0,
    });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    const dealSummary = repos.state.publishedDeals[0]!;
    const detail = await repos.publishedDeal.findById(dealSummary.id);

    expect(detail).not.toBeNull();
    expect(detail!.productName).toBeTruthy();
    expect(detail!.productUrl).toBeTruthy();
    expect(detail!.productImageUrl).toBeTruthy();
    expect(detail!.currentPrice).not.toBeNull();
    expect(detail!.dealScore).toBeGreaterThan(0);
    expect(detail!.channel).toBe("TEST");
    expect(detail!.publishedAt).toBeInstanceOf(Date);
    // Campos de produto que o resumo (listRecent) não trazia antes:
    expect(detail!.rating).not.toBeUndefined();
    expect(detail!.salesCount).not.toBeUndefined();
    expect(detail!.commissionPercent).not.toBeUndefined();
  });

  it("RejectedOffer.findById traz o snapshot completo (preço anterior, avaliação, etc.), não só o resumo", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 90 }); // força rejeição
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    const rejectedSummary = repos.state.rejected[0]!;
    const detail = await repos.rejectedOffer.findById(rejectedSummary.id);

    expect(detail).not.toBeNull();
    expect(detail!.offerSnapshot).not.toBeNull();
    const snapshot = JSON.parse(detail!.offerSnapshot!);
    // O snapshot já guardava esses campos - agora o endpoint os expõe.
    expect(snapshot.name).toBeTruthy();
    expect(snapshot.url).toBeTruthy();
    expect(snapshot.imageUrl).toBeTruthy();
    expect(snapshot.currentPrice).toBeGreaterThan(0);
    expect(detail!.reason).toBeTruthy();
    expect(detail!.createdAt).toBeInstanceOf(Date);
  });

  it("após aprovação manual, o detalhe da rejeição mostra quem aprovou e quando", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-42",
      effectiveMode: "TEST",
    });

    const detail = await repos.rejectedOffer.findById(rejected.id);
    expect(detail!.manuallyApprovedAt).not.toBeNull();
    expect(detail!.manuallyApprovedBy).toBe("admin-42");
  });

  it("findById retorna null para um id inexistente, em ambos os repositórios", async () => {
    const repos = createInMemoryRepositories();
    expect(await repos.publishedDeal.findById("nao-existe")).toBeNull();
    expect(await repos.rejectedOffer.findById("nao-existe")).toBeNull();
  });
});
