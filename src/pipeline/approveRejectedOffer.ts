import type { Repositories } from "../db/repositories.js";
import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import type { RawShopeeOffer, RunMode } from "../types/domain.js";
import { calculateDealScore, DEFAULT_DEAL_SCORE_WEIGHTS, type DealScoreWeights } from "../dealscore/calculateDealScore.js";
import { channelForMode } from "./runPipeline.js";

export class RejectedOfferNotFoundError extends Error {
  constructor() {
    super("Oferta rejeitada não encontrada.");
    this.name = "RejectedOfferNotFoundError";
  }
}

export class AlreadyApprovedError extends Error {
  constructor() {
    super("Esta oferta já foi aprovada manualmente antes.");
    this.name = "AlreadyApprovedError";
  }
}

export class MissingSnapshotError extends Error {
  constructor() {
    super(
      "Esta oferta foi rejeitada antes de o sistema guardar o snapshot completo — não é possível aprová-la retroativamente.",
    );
    this.name = "MissingSnapshotError";
  }
}

export interface ApproveRejectedOfferOptions {
  rejectedOfferId: string;
  repos: Repositories;
  shopeeClient: ShopeeClient;
  approvedBy: string;
  effectiveMode: RunMode;
  dealScoreWeights?: DealScoreWeights;
}

export interface ApproveRejectedOfferResult {
  productId: string;
  dealScore: number;
  affiliateLink: string;
}

/**
 * Reverte manualmente uma rejeição automática (seção 14 - painel deve
 * permitir intervenção humana). Reconstrói a oferta a partir do snapshot
 * guardado no momento da rejeição, e a persiste como se tivesse sido aceita
 * pelo pipeline normal - sem precisar buscar de novo na Shopee.
 *
 * Propositalmente NÃO passa pelos filtros de novo: aprovar manualmente é uma
 * decisão humana explícita que sobrepõe a decisão automática, não uma
 * segunda tentativa de avaliação (seção 33 - o humano assume a
 * responsabilidade por essa oferta específica).
 */
export async function approveRejectedOfferManually(
  opts: ApproveRejectedOfferOptions,
): Promise<ApproveRejectedOfferResult> {
  const { rejectedOfferId, repos, shopeeClient, approvedBy, effectiveMode } = opts;
  const weights = opts.dealScoreWeights ?? DEFAULT_DEAL_SCORE_WEIGHTS;

  const rejectedOffer = await repos.rejectedOffer.findById(rejectedOfferId);
  if (!rejectedOffer) throw new RejectedOfferNotFoundError();
  if (rejectedOffer.manuallyApprovedAt) throw new AlreadyApprovedError();
  if (!rejectedOffer.offerSnapshot) throw new MissingSnapshotError();

  const offer: RawShopeeOffer = JSON.parse(rejectedOffer.offerSnapshot);

  const existingProduct = await repos.product.findByShopeeItemId(offer.shopeeItemId);
  const priceStats = existingProduct ? await repos.priceHistory.getStats(existingProduct.id) : null;

  const affiliateLink = offer.affiliateLink ?? (await shopeeClient.getAffiliateLink(offer.shopeeItemId));
  const product = await repos.product.upsert(offer, affiliateLink);
  await repos.priceHistory.recordIfChanged(product.id, offer.currentPrice);

  const { score } = calculateDealScore({ offer, priceStats }, weights);

  await repos.publishedDeal.create({
    productId: product.id,
    priceAtPublish: offer.currentPrice,
    dealScore: score,
    channel: channelForMode(effectiveMode),
    approvedManually: true,
    approvedBy,
  });

  await repos.rejectedOffer.markManuallyApproved(rejectedOfferId, approvedBy);

  return { productId: product.id, dealScore: score, affiliateLink };
}
