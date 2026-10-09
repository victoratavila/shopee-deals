import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import {
  approveRejectedOfferManually,
  rejectApprovedOfferManually,
  revertManualApproval,
  UseUndoInsteadError,
  PublishedDealNotFoundError,
} from "../src/pipeline/approveRejectedOffer.js";
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

describe("rejectApprovedOfferManually - rejeitar uma oferta aprovada automaticamente", () => {
  it("remove a publicação e cria uma nova rejeição pendente com motivo MANUALLY_REJECTED", async () => {
    const repos = lenientRepos();
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const autoDeal = repos.state.publishedDeals.find((d) => !d.approvedManually)!;
    const dealsBefore = repos.state.publishedDeals.length;

    await rejectApprovedOfferManually(repos, autoDeal.id, "admin-1");

    expect(repos.state.publishedDeals.length).toBe(dealsBefore - 1);
    expect(repos.state.publishedDeals.some((d) => d.id === autoDeal.id)).toBe(false);

    const newRejection = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-001");
    expect(newRejection).toBeDefined();
    expect(newRejection!.reason).toBe("MANUALLY_REJECTED");
    expect(newRejection!.manuallyApprovedAt).toBeNull();
    expect(newRejection!.offerSnapshot).not.toBeNull();
  });

  it("a oferta rejeitada pode ser aprovada de novo depois (o ciclo é reversível)", async () => {
    const repos = lenientRepos();
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const autoDeal = repos.state.publishedDeals.find((d) => !d.approvedManually)!;

    await rejectApprovedOfferManually(repos, autoDeal.id, "admin-1");
    const rejection = repos.state.rejected.find((r) => r.reason === "MANUALLY_REJECTED")!;

    const result = await approveRejectedOfferManually({
      rejectedOfferId: rejection.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-2",
      effectiveMode: "TEST",
    });

    expect(result.productId).toBeDefined();
    expect(repos.state.publishedDeals.some((d) => d.sourceRejectedOfferId === rejection.id)).toBe(true);
  });

  it("recusa rejeitar uma oferta que já é uma aprovação MANUAL - pede pra usar Desfazer", async () => {
    const repos = lenientRepos({ minDiscountPercent: 20 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;
    await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });
    const manualDeal = repos.state.publishedDeals.find((d) => d.approvedManually)!;

    await expect(rejectApprovedOfferManually(repos, manualDeal.id, "admin-2")).rejects.toBeInstanceOf(
      UseUndoInsteadError,
    );
    // Nada foi apagado - a aprovação manual continua intacta.
    expect(repos.state.publishedDeals.some((d) => d.id === manualDeal.id)).toBe(true);
  });

  it("recusa rejeitar um id de oferta publicada inexistente", async () => {
    const repos = lenientRepos();
    await expect(rejectApprovedOfferManually(repos, "nao-existe", "admin-1")).rejects.toBeInstanceOf(
      PublishedDealNotFoundError,
    );
  });

  it("'Desfazer' continua funcionando normalmente para aprovações manuais (não foi afetado)", async () => {
    const repos = lenientRepos({ minDiscountPercent: 20 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;
    const result = await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });
    const deal = repos.state.publishedDeals.find((d) => d.productId === result.productId)!;

    await expect(revertManualApproval(repos, deal.id)).resolves.toBeUndefined();
    expect(rejected.manuallyApprovedAt).toBeNull();
  });
});

describe("deleteAll - limpar todas as ofertas (uso em teste)", () => {
  it("apaga TODAS as publicações e rejeições, incluindo aprovações manuais", async () => {
    const repos = lenientRepos({ minDiscountPercent: 20 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;
    await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });

    expect(repos.state.publishedDeals.length).toBeGreaterThan(0);
    expect(repos.state.rejected.length).toBeGreaterThan(0);

    const deletedDeals = await repos.publishedDeal.deleteAll();
    const deletedRejections = await repos.rejectedOffer.deleteAll();

    expect(deletedDeals).toBeGreaterThan(0);
    expect(deletedRejections).toBeGreaterThan(0);
    expect(repos.state.publishedDeals).toHaveLength(0);
    expect(repos.state.rejected).toHaveLength(0);
  });

  it("não deixa nenhum vínculo pendurado - depois de apagar tudo, uma nova rodada funciona normalmente", async () => {
    const repos = lenientRepos();
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    await repos.publishedDeal.deleteAll();
    await repos.rejectedOffer.deleteAll();

    // Precisa liberar o "run" anterior pra rodar de novo (mesma regra de sempre).
    await repos.run.reconcileStaleRuns(0);

    const result = await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    expect(result.dealsSelected).toBeGreaterThanOrEqual(0);
  });
});
