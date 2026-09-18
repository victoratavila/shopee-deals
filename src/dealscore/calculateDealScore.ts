import type { RawShopeeOffer } from "../types/domain.js";
import type { PriceStats } from "../pricehistory/suspiciousPrice.js";

export interface DealScoreWeights {
  discount: number;
  popularity: number;
  commission: number;
  rating: number;
  storeReputation: number;
  priceHistory: number;
}

/** Ponto de partida definido na seção 7 do escopo. Ajustável sem alterar código-fonte (via painel/Settings). */
export const DEFAULT_DEAL_SCORE_WEIGHTS: DealScoreWeights = {
  discount: 0.3,
  popularity: 0.2,
  commission: 0.2,
  rating: 0.15,
  storeReputation: 0.1,
  priceHistory: 0.05,
};

export interface DealScoreInput {
  offer: RawShopeeOffer;
  priceStats: PriceStats | null;
  /** reputação da loja, 0-100, quando disponível (fase futura: virá da API) */
  storeReputationScore?: number;
}

export interface DealScoreResult {
  score: number; // 0-100
  breakdown: Record<keyof DealScoreWeights, number>; // contribuição de cada fator, já ponderada
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calcula o Deal Score (0-100). Cada sub-score é normalizado para 0-100
 * antes de aplicar o peso, para que os pesos somem proporcionalmente ao
 * score final. Fatores ausentes contam como 0 no sub-score, não travam
 * o cálculo (importante porque a API pode não retornar todos os campos).
 */
export function calculateDealScore(
  input: DealScoreInput,
  weights: DealScoreWeights = DEFAULT_DEAL_SCORE_WEIGHTS,
): DealScoreResult {
  const { offer, priceStats, storeReputationScore } = input;

  const discountScore = clamp(offer.discountPercent ?? 0, 0, 100);

  // Popularidade: combina vendas e quantidade de avaliações numa escala log
  // para não deixar produtos "virais" dominarem de forma desproporcional.
  const salesComponent = Math.log10((offer.salesCount ?? 0) + 1) * 20;
  const reviewsComponent = Math.log10((offer.ratingCount ?? 0) + 1) * 20;
  const popularityScore = clamp(salesComponent + reviewsComponent, 0, 100);

  const commissionScore = clamp((offer.commissionPercent ?? 0) * 5, 0, 100); // 20% comissão = score 100

  const ratingScore = clamp(((offer.rating ?? 0) / 5) * 100, 0, 100);

  const storeReputationNormalized = clamp(storeReputationScore ?? 50, 0, 100); // 50 = neutro, sem dados

  // Histórico de preço: quanto mais próximo do menor preço histórico, maior o score.
  let priceHistoryScore = 50; // neutro quando não há histórico suficiente
  if (priceStats && priceStats.sampleSize >= 2 && priceStats.averagePrice > 0) {
    const ratioToAverage = offer.currentPrice / priceStats.averagePrice;
    // ratio 1.0 (preço = média) -> score 50; ratio <= 0.5 (metade da média) -> score 100
    priceHistoryScore = clamp(150 - ratioToAverage * 100, 0, 100);
  }

  const breakdown = {
    discount: discountScore * weights.discount,
    popularity: popularityScore * weights.popularity,
    commission: commissionScore * weights.commission,
    rating: ratingScore * weights.rating,
    storeReputation: storeReputationNormalized * weights.storeReputation,
    priceHistory: priceHistoryScore * weights.priceHistory,
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const score = clamp(Object.values(breakdown).reduce((a, b) => a + b, 0) / totalWeight, 0, 100);

  return { score, breakdown };
}
