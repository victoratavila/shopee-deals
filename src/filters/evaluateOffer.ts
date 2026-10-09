import type { RawShopeeOffer, RejectedOfferResult, RejectionReason } from "../types/domain.js";
import type { OperationalSettings } from "../config/operationalSettings.js";

export interface OfferContext {
  /** true se este produto já foi publicado dentro do intervalo de republicação configurado */
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

function isInvalidOptionalNumber(
  value: number | undefined,
  isValid: (number: number) => boolean,
): boolean {
  return value !== undefined && (!Number.isFinite(value) || !isValid(value));
}

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
    typeof offer.shopeeItemId !== "string" ||
    !offer.shopeeItemId.trim() ||
    typeof offer.name !== "string" ||
    !offer.name.trim() ||
    typeof offer.url !== "string" ||
    !offer.url.trim() ||
    typeof offer.currentPrice !== "number" ||
    !Number.isFinite(offer.currentPrice) ||
    offer.currentPrice <= 0
  ) {
    return { accepted: false, reason: "INVALID_DATA", details: "Campos obrigatórios ausentes ou inválidos" };
  }

  if (
    isInvalidOptionalNumber(offer.previousPrice, (value) => value > 0) ||
    isInvalidOptionalNumber(offer.discountPercent, (value) => value >= 0 && value <= 100) ||
    isInvalidOptionalNumber(offer.rating, (value) => value >= 0 && value <= 5) ||
    isInvalidOptionalNumber(offer.ratingCount, (value) => Number.isInteger(value) && value >= 0) ||
    isInvalidOptionalNumber(offer.salesCount, (value) => Number.isInteger(value) && value >= 0) ||
    isInvalidOptionalNumber(offer.commissionPercent, (value) => value >= 0 && value <= 100)
  ) {
    return { accepted: false, reason: "INVALID_DATA", details: "Dados numéricos da oferta são inválidos" };
  }

  if (context.isDuplicateInRound) {
    return { accepted: false, reason: "DUPLICATE", details: "Produto já processado nesta rodada" };
  }

  if (context.recentlyPublished) {
    return {
      accepted: false,
      reason: "RECENTLY_PUBLISHED",
      details: `Publicado há menos de ${settings.republishIntervalMinutes} minuto(s)`,
    };
  }

  if (context.isSuspiciousPrice) {
    return {
      accepted: false,
      reason: "SUSPICIOUS_PRICE",
      details: context.suspiciousReason ?? "Preço/desconto inconsistente com o histórico",
    };
  }

  if (settings.minPrice !== null && offer.currentPrice < settings.minPrice) {
    return {
      accepted: false,
      reason: "PRICE_OUT_OF_RANGE",
      details: `Preço ${offer.currentPrice} abaixo do mínimo ${settings.minPrice}`,
    };
  }

  if (settings.maxPrice !== null && offer.currentPrice > settings.maxPrice) {
    return {
      accepted: false,
      reason: "PRICE_OUT_OF_RANGE",
      details: `Preço ${offer.currentPrice} acima do máximo ${settings.maxPrice}`,
    };
  }

  if (settings.minDiscountPercent !== null && (offer.discountPercent ?? 0) < settings.minDiscountPercent) {
    return {
      accepted: false,
      reason: "DISCOUNT_BELOW_MINIMUM",
      details: `Desconto ${offer.discountPercent ?? 0}% < mínimo ${settings.minDiscountPercent}%`,
    };
  }

  if (settings.minRating !== null && (offer.rating ?? 0) < settings.minRating) {
    return {
      accepted: false,
      reason: "RATING_BELOW_MINIMUM",
      details: `Avaliação ${offer.rating ?? 0} < mínimo ${settings.minRating}`,
    };
  }

  if (settings.minRatingCount !== null && (offer.ratingCount ?? 0) < settings.minRatingCount) {
    return {
      accepted: false,
      reason: "REVIEWS_BELOW_MINIMUM",
      details: `${offer.ratingCount ?? 0} avaliações < mínimo ${settings.minRatingCount}`,
    };
  }

  if (settings.minSalesCount !== null && (offer.salesCount ?? 0) < settings.minSalesCount) {
    return {
      accepted: false,
      reason: "SALES_BELOW_MINIMUM",
      details: `${offer.salesCount ?? 0} vendas < mínimo ${settings.minSalesCount}`,
    };
  }

  if (settings.minCommissionPercent !== null && (offer.commissionPercent ?? 0) < settings.minCommissionPercent) {
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
