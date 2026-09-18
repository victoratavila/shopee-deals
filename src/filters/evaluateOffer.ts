import type { RawShopeeOffer, RejectedOfferResult, RejectionReason } from "../types/domain.js";
import type { OperationalSettings } from "../config/operationalSettings.js";

export interface OfferContext {
  /** true se este produto já foi publicado dentro da janela de "minDaysBeforeRepublish" */
  recentlyPublished: boolean;
  /** true se já apareceu nesta mesma rodada (duplicidade dentro da execução) */
  isDuplicateInRound: boolean;
  /** resultado da análise de histórico de preços (ver priceHistory/suspiciousPrice.ts) */
  isSuspiciousPrice: boolean;
  suspiciousReason?: string;
}

export type EvaluationResult =
  | { accepted: true }
  | { accepted: false; reason: RejectionReason; details?: string };

/**
 * Avalia uma oferta contra as configurações operacionais. Função pura:
 * não acessa banco nem rede, recebe tudo already-computed via `context`.
 * Isso permite testar todas as combinações de filtros isoladamente.
 */
export function evaluateOffer(
  offer: RawShopeeOffer,
  settings: OperationalSettings,
  context: OfferContext,
): EvaluationResult {
  // 1. Dados obrigatórios ausentes/incoerentes -> rejeita sem tentar adivinhar
  if (
    !offer.shopeeItemId ||
    !offer.name ||
    !offer.url ||
    typeof offer.currentPrice !== "number" ||
    offer.currentPrice <= 0
  ) {
    return { accepted: false, reason: "INVALID_DATA", details: "Campos obrigatórios ausentes ou inválidos" };
  }

  if (context.isDuplicateInRound) {
    return { accepted: false, reason: "DUPLICATE", details: "Produto já processado nesta rodada" };
  }

  if (context.recentlyPublished) {
    return {
      accepted: false,
      reason: "RECENTLY_PUBLISHED",
      details: `Publicado há menos de ${settings.minDaysBeforeRepublish} dia(s)`,
    };
  }

  if (context.isSuspiciousPrice) {
    return {
      accepted: false,
      reason: "SUSPICIOUS_PRICE",
      details: context.suspiciousReason ?? "Preço/desconto inconsistente com o histórico",
    };
  }

  if (offer.currentPrice < settings.minPrice || offer.currentPrice > settings.maxPrice) {
    return {
      accepted: false,
      reason: "PRICE_OUT_OF_RANGE",
      details: `Preço ${offer.currentPrice} fora da faixa [${settings.minPrice}, ${settings.maxPrice}]`,
    };
  }

  if ((offer.discountPercent ?? 0) < settings.minDiscountPercent) {
    return {
      accepted: false,
      reason: "DISCOUNT_BELOW_MINIMUM",
      details: `Desconto ${offer.discountPercent ?? 0}% < mínimo ${settings.minDiscountPercent}%`,
    };
  }

  if ((offer.rating ?? 0) < settings.minRating) {
    return {
      accepted: false,
      reason: "RATING_BELOW_MINIMUM",
      details: `Avaliação ${offer.rating ?? 0} < mínimo ${settings.minRating}`,
    };
  }

  if ((offer.ratingCount ?? 0) < settings.minRatingCount) {
    return {
      accepted: false,
      reason: "REVIEWS_BELOW_MINIMUM",
      details: `${offer.ratingCount ?? 0} avaliações < mínimo ${settings.minRatingCount}`,
    };
  }

  if ((offer.salesCount ?? 0) < settings.minSalesCount) {
    return {
      accepted: false,
      reason: "SALES_BELOW_MINIMUM",
      details: `${offer.salesCount ?? 0} vendas < mínimo ${settings.minSalesCount}`,
    };
  }

  if ((offer.commissionPercent ?? 0) < settings.minCommissionPercent) {
    return {
      accepted: false,
      reason: "COMMISSION_BELOW_MINIMUM",
      details: `Comissão ${offer.commissionPercent ?? 0}% < mínimo ${settings.minCommissionPercent}%`,
    };
  }

  if (offer.category && settings.blockedCategories.includes(offer.category)) {
    return { accepted: false, reason: "CATEGORY_BLOCKED", details: `Categoria "${offer.category}" bloqueada` };
  }

  if (
    settings.allowedCategories.length > 0 &&
    (!offer.category || !settings.allowedCategories.includes(offer.category))
  ) {
    return {
      accepted: false,
      reason: "CATEGORY_NOT_ALLOWED",
      details: `Categoria "${offer.category ?? "desconhecida"}" não está na lista de permitidas`,
    };
  }

  return { accepted: true };
}

export function toRejectedOfferResult(
  offer: RawShopeeOffer,
  result: Extract<EvaluationResult, { accepted: false }>,
): RejectedOfferResult {
  return {
    shopeeItemId: offer.shopeeItemId,
    productName: offer.name,
    reason: result.reason,
    ...(result.details !== undefined ? { details: result.details } : {}),
  };
}
