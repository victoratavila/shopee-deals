import { describe, it, expect } from "vitest";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import {
  approveRejectedOfferManually,
  RejectedOfferNotFoundError,
  AlreadyApprovedError,
  MissingSnapshotError,
} from "../src/pipeline/approveRejectedOffer.js";
import { MockShopeeClient } from "../src/shopee/MockShopeeClient.js";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";

describe("approveRejectedOfferManually", () => {
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
