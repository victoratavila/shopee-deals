import { describe, it, expect } from "vitest";
import { calculateDealScore, DEFAULT_DEAL_SCORE_WEIGHTS } from "../src/dealscore/calculateDealScore.js";
import { checkSuspiciousPrice } from "../src/pricehistory/suspiciousPrice.js";
import type { RawShopeeOffer } from "../src/types/domain.js";

const offer: RawShopeeOffer = {
  shopeeItemId: "ITEM-1",
  name: "Produto teste",
  url: "https://example.invalid/item-1",
  currentPrice: 50,
  previousPrice: 100,
  discountPercent: 50,
  rating: 4.8,
  ratingCount: 500,
  salesCount: 2000,
  commissionPercent: 10,
};

describe("calculateDealScore", () => {
  it("retorna score entre 0 e 100", () => {
    const { score } = calculateDealScore({ offer, priceStats: null });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("uma oferta melhor (mais desconto, mais vendas) gera score maior", () => {
    const weakOffer: RawShopeeOffer = { ...offer, discountPercent: 5, salesCount: 1, ratingCount: 1 };
    const strong = calculateDealScore({ offer, priceStats: null });
    const weak = calculateDealScore({ offer: weakOffer, priceStats: null });
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("pesos customizados alteram o resultado", () => {
    const heavyDiscount = calculateDealScore({ offer, priceStats: null }, {
      ...DEFAULT_DEAL_SCORE_WEIGHTS,
      discount: 1,
      popularity: 0,
      commission: 0,
      rating: 0,
      storeReputation: 0,
      priceHistory: 0,
    });
    expect(heavyDiscount.score).toBeCloseTo(offer.discountPercent!, 0);
  });
});

describe("checkSuspiciousPrice", () => {
  it("não marca como suspeito quando não há histórico suficiente", () => {
    const result = checkSuspiciousPrice(offer, null, 60);
    expect(result.suspicious).toBe(false);
  });

  it("marca como suspeito quando previousPrice é muito maior que o histórico real", () => {
    const result = checkSuspiciousPrice(
      offer,
      { lowestPrice: 45, averagePrice: 48, lastKnownPrice: 47, sampleSize: 5 },
      60,
    );
    expect(result.suspicious).toBe(true);
  });

  it("não marca como suspeito quando previousPrice é coerente com o histórico", () => {
    const coherentOffer = { ...offer, previousPrice: 55 };
    const result = checkSuspiciousPrice(
      coherentOffer,
      { lowestPrice: 45, averagePrice: 50, lastKnownPrice: 52, sampleSize: 5 },
      60,
    );
    expect(result.suspicious).toBe(false);
  });
});
