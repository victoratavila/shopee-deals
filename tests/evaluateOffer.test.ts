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

  it.each([
    ["preço mínimo", { currentPrice: 49 }, { minPrice: 50 }, "PRICE_OUT_OF_RANGE"],
    ["preço máximo", { currentPrice: 101 }, { maxPrice: 100 }, "PRICE_OUT_OF_RANGE"],
    ["avaliação", { rating: 3.9 }, { minRating: 4 }, "RATING_BELOW_MINIMUM"],
    ["vendas", { salesCount: 9 }, { minSalesCount: 10 }, "SALES_BELOW_MINIMUM"],
    ["comissão", { commissionPercent: 2 }, { minCommissionPercent: 3 }, "COMMISSION_BELOW_MINIMUM"],
  ] as Array<[string, Partial<RawShopeeOffer>, Partial<ReturnType<typeof defaultOperationalSettings>>, string]>)(
    "rejeita quando o filtro de %s não é atendido",
    (_filter, offerOverrides, settingsOverrides, expectedReason) => {
      const settings = { ...defaultOperationalSettings(), ...settingsOverrides };
      const result = evaluateOffer(baseOffer(offerOverrides), settings, baseContext);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.reason).toBe(expectedReason);
    },
  );

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

  it("rejeita campos obrigatórios que não são strings válidas", () => {
    const offer = baseOffer();
    Reflect.set(offer, "name", null);
    const result = evaluateOffer(offer, defaultOperationalSettings(), baseContext);

    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("INVALID_DATA");
  });

  it.each([
    ["preço NaN", { currentPrice: Number.NaN }],
    ["preço infinito", { currentPrice: Number.POSITIVE_INFINITY }],
    ["desconto NaN", { discountPercent: Number.NaN }],
    ["avaliação NaN", { rating: Number.NaN }],
    ["contagem de avaliações fracionária", { ratingCount: 1.5 }],
    ["vendas negativas", { salesCount: -1 }],
    ["comissão acima de 100%", { commissionPercent: 101 }],
    ["preço anterior zero", { previousPrice: 0 }],
  ] as Array<[string, Partial<RawShopeeOffer>]>)(
    "rejeita dados numéricos inválidos (%s) em vez de deixá-los passar pelos filtros",
    (_description, offerOverrides) => {
      const result = evaluateOffer(baseOffer(offerOverrides), defaultOperationalSettings(), baseContext);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.reason).toBe("INVALID_DATA");
    },
  );

  it("rejeita contagem de avaliações ausente quando há um mínimo configurado", () => {
    const offer = baseOffer();
    delete offer.ratingCount;
    const result = evaluateOffer(offer, defaultOperationalSettings(), baseContext);

    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe("REVIEWS_BELOW_MINIMUM");
  });

  it("null em um limite significa 'sem limite' - aceita mesmo abaixo do padrão", () => {
    const settings = { ...defaultOperationalSettings(), minDiscountPercent: null, minRatingCount: null };
    const result = evaluateOffer(
      baseOffer({ discountPercent: 1, ratingCount: 0 }),
      settings,
      baseContext,
    );
    expect(result.accepted).toBe(true);
  });

  it("null em minPrice/maxPrice desativa a checagem de faixa de preço", () => {
    const settings = { ...defaultOperationalSettings(), minPrice: null, maxPrice: null };
    const result = evaluateOffer(baseOffer({ currentPrice: 999999 }), settings, baseContext);
    expect(result.accepted).toBe(true);
  });
});
