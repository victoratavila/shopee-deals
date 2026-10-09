import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import {
  approveRejectedOfferManually,
  revertManualApproval,
  RejectedOfferNotFoundError,
  AlreadyApprovedError,
  MissingSnapshotError,
  RecentlyPublishedError,
  DailyLimitReachedError,
  PublishedDealNotFoundError,
  NotManuallyApprovedError,
} from "../src/pipeline/approveRejectedOffer.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

describe("approveRejectedOfferManually", () => {
  it("preserva a categoria de busca ao aprovar uma oferta manualmente", async () => {
    const repos = createInMemoryRepositories({
      searchMode: "CATEGORIES",
      keywordCategories: [
        { id: "electronics", name: "Eletrônicos", keywords: ["suporte"], selected: true },
      ],
      minDiscountPercent: 20,
      minRatingCount: 0,
      minSalesCount: 0,
      minRating: 0,
      minCommissionPercent: 0,
    });
    await runPipeline({
      shopeeClient: new MockShopeeClient(),
      repos,
      mode: "TEST",
      triggeredBy: "test",
    });
    const rejected = repos.state.rejected.find((entry) => entry.shopeeItemId === "FIXTURE-002");
    expect(rejected).toBeDefined();

    const result = await approveRejectedOfferManually({
      rejectedOfferId: rejected!.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });

    const published = repos.state.publishedDeals.find((deal) => deal.productId === result.productId);
    expect(published?.searchCategoryId).toBe("keyword:suporte");
    expect(published?.searchCategoryName).toBe("suporte");
  });

  it("aprova uma oferta rejeitada e ela passa a aparecer como publicada", async () => {
    // Filtros estritos o suficiente para rejeitar FIXTURE-002 (desconto baixo).
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002");
    expect(rejected).toBeDefined();
    expect(rejected!.offerSnapshot).not.toBeNull();

    const result = await approveRejectedOfferManually({
      rejectedOfferId: rejected!.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });

    expect(result.productId).toBeDefined();
    expect(repos.state.publishedDeals.some((d) => d.productId === result.productId && d.approvedManually)).toBe(
      true,
    );
  });

  it("marca a rejeição original como aprovada manualmente, evitando aprovar duas vezes", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });

    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: rejected.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ).rejects.toBeInstanceOf(AlreadyApprovedError);
  });

  it("recusa aprovar um id de rejeição inexistente", async () => {
    const repos = createInMemoryRepositories();
    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: "nao-existe",
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ).rejects.toBeInstanceOf(RejectedOfferNotFoundError);
  });

  it("recusa aprovar uma rejeição sem snapshot salvo", async () => {
    const repos = createInMemoryRepositories();
    repos.state.rejected.push({
      id: "sem-snapshot",
      shopeeItemId: "OLD-1",
      productName: "Produto antigo",
      reason: "DISCOUNT_BELOW_MINIMUM",
      details: null,
      offerSnapshot: null,
      manuallyApprovedAt: null,
      manuallyApprovedBy: null,
      createdAt: new Date(),
    });

    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: "sem-snapshot",
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ).rejects.toBeInstanceOf(MissingSnapshotError);
  });
});

describe("revertManualApproval", () => {
  it("remove a publicação e faz a rejeição original voltar a aparecer como pendente", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
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
    await revertManualApproval(repos, deal.id);

    expect(repos.state.publishedDeals.some((d) => d.id === deal.id)).toBe(false);
    expect(rejected.manuallyApprovedAt).toBeNull();
  });

  it("permite aprovar de novo depois de reverter (não fica preso como 'já aprovada')", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    const first = await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });
    const deal = repos.state.publishedDeals.find((d) => d.productId === first.productId)!;
    await revertManualApproval(repos, deal.id);

    // Não deve lançar AlreadyApprovedError - a reversão limpou o estado.
    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: rejected.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-2",
        effectiveMode: "TEST",
      }),
    ).resolves.toBeDefined();
  });

  it("recusa reverter um id de publicação inexistente", async () => {
    const repos = createInMemoryRepositories();
    await expect(revertManualApproval(repos, "nao-existe")).rejects.toBeInstanceOf(PublishedDealNotFoundError);
  });

  it("recusa reverter uma publicação que não foi aprovada manualmente (veio do pipeline normal)", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 0, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const normalDeal = repos.state.publishedDeals.find((d) => !d.approvedManually)!;

    await expect(revertManualApproval(repos, normalDeal.id)).rejects.toBeInstanceOf(NotManuallyApprovedError);
  });
});

describe("aprovação automática vs. manual - fluxo esperado", () => {
  it("oferta que atende aos critérios é aprovada AUTOMATICAMENTE, sem passar por approveRejectedOfferManually", async () => {
    const repos = createInMemoryRepositories({
      minDiscountPercent: 0,
      minRatingCount: 0,
      minSalesCount: 0,
      minRating: 0,
      minCommissionPercent: 0,
    });
    const result = await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    expect(result.dealsSelected).toBeGreaterThan(0);
    const autoDeal = repos.state.publishedDeals[0]!;
    // "pronta para publicação futura": tem tudo que uma futura integração
    // com WhatsApp/Telegram vai precisar, e não foi marcada como manual.
    expect(autoDeal.approvedManually).toBe(false);
    expect(autoDeal.sourceRejectedOfferId).toBeUndefined();
    expect(autoDeal.productId).toBeDefined();
    expect(autoDeal.dealScore).toBeGreaterThan(0);
  });

  it("oferta que não atende aos critérios é rejeitada automaticamente, com motivo registrado", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 99 }); // ninguém passa
    const result = await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    expect(result.dealsSelected).toBe(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    for (const r of result.rejected) {
      expect(r.reason).toBeTruthy();
    }
  });

  it("aprovação manual recusa produto já aprovado/publicado recentemente (evita duplicidade entre auto e manual)", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });

    // Rodada 1: filtros estritos rejeitam FIXTURE-002 por desconto baixo.
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    // Simula que o mesmo produto foi aprovado (automática ou manualmente)
    // em outro momento, depois da rejeição original ter sido registrada.
    const product = await repos.product.upsert(
      { ...JSON.parse(rejected.offerSnapshot!), shopeeItemId: "FIXTURE-002" },
      "https://example.invalid/affiliate/FIXTURE-002",
    );
    await repos.publishedDeal.create({
      productId: product.id,
      priceAtPublish: 19.9,
      dealScore: 50,
      channel: "TEST",
    });

    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: rejected.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ).rejects.toBeInstanceOf(RecentlyPublishedError);
  });

  it("aprovação manual respeita o limite diário", async () => {
    const repos = createInMemoryRepositories({
      minDiscountPercent: 20,
      minRatingCount: 0,
      minSalesCount: 0,
      maxOffersPerDay: 1,
      republishIntervalMinutes: null, // isola o teste - só queremos testar o limite diário aqui
    });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    // A rodada acima já publicou 1 oferta (FIXTURE-001), atingindo o limite diário de 1.
    expect(repos.state.publishedDeals.length).toBeGreaterThanOrEqual(1);

    await expect(
      approveRejectedOfferManually({
        rejectedOfferId: rejected.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ).rejects.toBeInstanceOf(DailyLimitReachedError);
  });

  it("dois cliques rápidos em 'Aprovar' não criam duas publicações (reivindicação atômica)", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    const attempt = () =>
      approveRejectedOfferManually({
        rejectedOfferId: rejected.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejectedAttempts = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejectedAttempts).toHaveLength(1);
    expect((rejectedAttempts[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyApprovedError);

    const dealsForProduct = repos.state.publishedDeals.filter((d) => d.approvedManually);
    expect(dealsForProduct).toHaveLength(1);
  });

  it("duas REJEIÇÕES DIFERENTES do mesmo produto aprovadas ao mesmo tempo não geram duas publicações", async () => {
    // Cenário real: o mesmo shopeeItemId foi rejeitado em duas rodadas
    // distintas (ex: em uma por desconto baixo, em outra por avaliação
    // baixa), gerando duas linhas de RejectedOffer diferentes - nenhuma
    // delas foi aprovada ainda. Se as duas forem aprovadas quase ao mesmo
    // tempo, só uma pode "vencer".
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const original = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    // Simula uma segunda linha de rejeição para o MESMO produto (outra rodada).
    const snapshot = JSON.parse(original.offerSnapshot!);
    repos.state.rejected.push({
      id: "rejected-duplicate-row",
      shopeeItemId: "FIXTURE-002",
      productName: original.productName,
      reason: original.reason,
      details: original.details,
      offerSnapshot: JSON.stringify(snapshot),
      manuallyApprovedAt: null,
      manuallyApprovedBy: null,
      createdAt: new Date(),
    });

    const results = await Promise.allSettled([
      approveRejectedOfferManually({
        rejectedOfferId: original.id,
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
      approveRejectedOfferManually({
        rejectedOfferId: "rejected-duplicate-row",
        repos,
        shopeeClient: new MockShopeeClient(),
        approvedBy: "admin-1",
        effectiveMode: "TEST",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejectedAttempts = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejectedAttempts).toHaveLength(1);
    expect((rejectedAttempts[0] as PromiseRejectedResult).reason).toBeInstanceOf(RecentlyPublishedError);

    // Só uma publicação manual existe para o produto, apesar de duas
    // rejeições diferentes terem sido "aprovadas" quase ao mesmo tempo.
    const manualDeals = repos.state.publishedDeals.filter((d) => d.approvedManually);
    expect(manualDeals).toHaveLength(1);

    // A rejeição que perdeu a corrida NÃO fica presa como "aprovada" sem
    // ter criado nada - a reivindicação foi desfeita (rollback).
    const losingRow = repos.state.rejected.find(
      (r) => r.id !== manualDealsSourceId(repos, manualDeals[0]!.productId),
    );
    expect(losingRow?.manuallyApprovedAt).toBeNull();
  });
});

function manualDealsSourceId(
  repos: ReturnType<typeof createInMemoryRepositories>,
  productId: string,
): string | undefined {
  return repos.state.publishedDeals.find((d) => d.productId === productId)?.sourceRejectedOfferId;
}

describe("deleteAllPending - limpar o banco de rejeições", () => {
  it("apaga rejeições pendentes, mas preserva as já aprovadas manualmente", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });

    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;
    await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });

    const pendingBefore = repos.state.rejected.filter((r) => r.manuallyApprovedAt === null).length;
    expect(pendingBefore).toBeGreaterThan(0);

    const deletedCount = await repos.rejectedOffer.deleteAllPending();

    expect(deletedCount).toBe(pendingBefore);
    expect(repos.state.rejected.every((r) => r.manuallyApprovedAt !== null)).toBe(true);
    // A rejeição já aprovada continua lá, então "Desfazer" ainda funciona.
    expect(repos.state.rejected.some((r) => r.id === rejected.id)).toBe(true);
  });

  it("depois de apagar, 'Desfazer' em uma aprovação manual continua funcionando", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 20, minRatingCount: 0, minSalesCount: 0 });
    await runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy: "test" });
    const rejected = repos.state.rejected.find((r) => r.shopeeItemId === "FIXTURE-002")!;

    const result = await approveRejectedOfferManually({
      rejectedOfferId: rejected.id,
      repos,
      shopeeClient: new MockShopeeClient(),
      approvedBy: "admin-1",
      effectiveMode: "TEST",
    });
    await repos.rejectedOffer.deleteAllPending();

    const deal = repos.state.publishedDeals.find((d) => d.productId === result.productId)!;
    await expect(revertManualApproval(repos, deal.id)).resolves.toBeUndefined();
  });
});

describe("scheduler vs. execução manual - sem estados duplicados", () => {
  it("duas execuções de pipeline concorrentes: só uma roda, a outra recebe ConcurrentRunError", async () => {
    const repos = createInMemoryRepositories({ minDiscountPercent: 0, minRatingCount: 0, minSalesCount: 0 });

    const attempt = (triggeredBy: string) =>
      runPipeline({ shopeeClient: new MockShopeeClient(), repos, mode: "TEST", triggeredBy });

    const results = await Promise.allSettled([attempt("scheduler"), attempt("manual")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.name).toBe("ConcurrentRunError");

    // nenhuma execução fica travada em RUNNING depois que tudo se resolve
    expect(repos.state.runs.some((r) => r.status === "RUNNING")).toBe(false);
  });
});
