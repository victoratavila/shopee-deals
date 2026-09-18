import { describe, it, expect } from "vitest";
import { evaluateOffer } from "../src/filters/evaluateOffer.js";
import { defaultOperationalSettings } from "../src/config/operationalSettings.js";
import type { RawShopeeOffer } from "../src/types/domain.js";

function baseOffer(overrides: Partial<RawShopeeOffer> = {}): RawShopeeOffer {
  return {
    shopeeItemId: "ITEM-1",
    name: "Produto teste",
    url: "https://example.invalid/item-1",
    currentPrice: 100,
    previousPrice: 150,
    discountPercent: 30,
    rating: 4.5,
    ratingCount: 100,
    salesCount: 50,
    commissionPercent: 5,
    category: "eletronicos",
    ...overrides,
  };
}

const baseContext = {
  recentlyPublished: false,
  isDuplicateInRound: false,
  isSuspiciousPrice: false,
};

describe("evaluateOffer", () => {
  it("aceita uma oferta que atende a todos os critérios padrão", () => {
    const result = evaluateOffer(baseOffer(), defaultOperationalSettings(), baseContext);
    expect(result.accepted).toBe(true);
  });

  it("rejeita quando desconto está abaixo do mínimo", () => {
    const settings = { ...defaultOperationalSettings(), minDiscountPercent: 50 };
    const result = evaluateOffer(baseOffer({ discountPercent: 20 }), settings, baseContext);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("DISCOUNT_BELOW_MINIMUM");
  });

  it("rejeita produtos com poucas avaliações", () => {
    const result = evaluateOffer(baseOffer({ ratingCount: 5 }), defaultOperationalSettings(), baseContext);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("REVIEWS_BELOW_MINIMUM");
  });

  it("rejeita categoria bloqueada", () => {
    const settings = { ...defaultOperationalSettings(), blockedCategories: ["eletronicos"] };
    const result = evaluateOffer(baseOffer(), settings, baseContext);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("CATEGORY_BLOCKED");
  });

  it("rejeita categoria fora da lista de permitidas", () => {
    const settings = { ...defaultOperationalSettings(), allowedCategories: ["moda"] };
    const result = evaluateOffer(baseOffer(), settings, baseContext);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("CATEGORY_NOT_ALLOWED");
  });

  it("rejeita produto publicado recentemente", () => {
    const result = evaluateOffer(baseOffer(), defaultOperationalSettings(), {
      ...baseContext,
      recentlyPublished: true,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("RECENTLY_PUBLISHED");
  });

  it("rejeita duplicado dentro da mesma rodada", () => {
    const result = evaluateOffer(baseOffer(), defaultOperationalSettings(), {
      ...baseContext,
      isDuplicateInRound: true,
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("DUPLICATE");
  });

  it("rejeita preço suspeito", () => {
    const result = evaluateOffer(baseOffer(), defaultOperationalSettings(), {
      ...baseContext,
      isSuspiciousPrice: true,
      suspiciousReason: "teste",
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("SUSPICIOUS_PRICE");
  });

  it("rejeita dados inválidos (preço zero)", () => {
    const result = evaluateOffer(baseOffer({ currentPrice: 0 }), defaultOperationalSettings(), baseContext);
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("INVALID_DATA");
  });
});
