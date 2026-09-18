import type { RawShopeeOffer } from "../types/domain.js";

export interface PriceStats {
  /** menor preço já registrado para este produto */
  lowestPrice: number;
  /** média histórica de preço */
  averagePrice: number;
  /** último preço registrado antes deste (nosso histórico, não o da Shopee) */
  lastKnownPrice: number | null;
  /** quantidade de pontos de histórico disponíveis */
  sampleSize: number;
}

export interface SuspiciousCheckResult {
  suspicious: boolean;
  reason?: string;
}

/**
 * Não confia cegamente no `previousPrice` informado pela Shopee (seção 8).
 * Compara com o histórico real armazenado no nosso banco. Se não houver
 * histórico suficiente, não acusa suspeita (não há base para desconfiar),
 * mas também não infla a confiança — o filtro de desconto mínimo continua
 * valendo normalmente.
 */
export function checkSuspiciousPrice(
  offer: RawShopeeOffer,
  stats: PriceStats | null,
  maxDeviationPercent: number,
): SuspiciousCheckResult {
  if (!stats || stats.sampleSize < 2) {
    return { suspicious: false };
  }

  // 1. O "preço anterior" declarado pela Shopee é muito maior que qualquer
  // preço já visto no nosso histórico -> desconto provavelmente inflado.
  if (offer.previousPrice) {
    const referenceMax = Math.max(stats.averagePrice, stats.lastKnownPrice ?? 0);
    if (referenceMax > 0) {
      const deviation = ((offer.previousPrice - referenceMax) / referenceMax) * 100;
      if (deviation > maxDeviationPercent) {
        return {
          suspicious: true,
          reason: `Preço "anterior" informado (${offer.previousPrice}) é ${deviation.toFixed(
            0,
          )}% maior que a referência histórica (${referenceMax.toFixed(2)})`,
        };
      }
    }
  }

  // 2. O preço atual está mais baixo que o menor preço histórico por uma
  // margem implausível — pode indicar erro de dados ou manipulação.
  if (stats.lowestPrice > 0) {
    const dropBelowLowest = ((stats.lowestPrice - offer.currentPrice) / stats.lowestPrice) * 100;
    if (dropBelowLowest > maxDeviationPercent) {
      return {
        suspicious: true,
        reason: `Preço atual (${offer.currentPrice}) está ${dropBelowLowest.toFixed(
          0,
        )}% abaixo do menor preço histórico (${stats.lowestPrice})`,
      };
    }
  }

  return { suspicious: false };
}
