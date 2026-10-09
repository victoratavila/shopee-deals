import type { Repositories } from "../db/repositories.js";
import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import type { RawShopeeOffer, RunMode } from "../types/domain.js";
import { calculateDealScore, DEFAULT_DEAL_SCORE_WEIGHTS, type DealScoreWeights } from "../dealscore/calculateDealScore.js";
import { channelForMode } from "./runPipeline.js";
import { isDailyLimitReached, DailyLimitReachedError } from "./dailyLimit.js";
// Reexportado por compatibilidade - server.ts importa DailyLimitReachedError a partir daqui.
export { DailyLimitReachedError };

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

export class RecentlyPublishedError extends Error {
  constructor(days: number) {
    super(
      `Este produto já foi aprovado/publicado nos últimos ${days} dia(s) (a mesma regra "dias antes de republicar" que vale para a seleção automática). Se quiser publicar de novo mesmo assim, aguarde a janela passar ou ajuste essa configuração.`,
    );
    this.name = "RecentlyPublishedError";
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
 * Aprova manualmente uma oferta que o sistema rejeitou automaticamente.
 * Esta é a ÚNICA forma de aprovação manual que existe no sistema - ofertas
 * que já passam nos critérios configurados são aprovadas automaticamente
 * pelo pipeline (`runPipeline.ts`), sem qualquer intervenção humana. Esta
 * função existe apenas como exceção, para o usuário reverter uma rejeição
 * que ele considera equivocada.
 *
 * Propositalmente NÃO reavalia os filtros (`evaluateOffer`) nem a suspeita
 * de preço manipulado: aprovar manualmente é uma decisão humana explícita
 * que sobrepõe a decisão automática - incluindo quando o motivo original
 * foi justamente "preço suspeito". Refazer essas checagens aqui anularia o
 * propósito do recurso (seção 33/14 do escopo original: o humano assume a
 * responsabilidade por essa oferta específica).
 *
 * As regras que CONTINUAM valendo, porque protegem a integridade dos dados
 * e não o "julgamento de qualidade" da oferta em si:
 *  - publicação recente (mesmo produto não pode ser aprovado de novo dentro
 *    da janela de `minDaysBeforeRepublish` - também cobre o caso de o
 *    produto já ter sido aprovado automaticamente depois desta rejeição);
 *  - limite diário de ofertas;
 *  - duplicidade (reivindicação atômica da rejeição - impede dois cliques
 *    rápidos em "Aprovar" criarem duas publicações).
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
  const settings = await repos.settings.getOperationalSettings();
  const republishCutoff =
    settings.minDaysBeforeRepublish !== null
      ? new Date(Date.now() - settings.minDaysBeforeRepublish * 24 * 60 * 60 * 1000)
      : null;

  // --- checagem "rápida" de publicação recente (mesma regra do pipeline
  // automático) - dá um erro claro no caminho comum, sem esperar até o
  // fim. A garantia de verdade contra duas rejeições DIFERENTES do MESMO
  // PRODUTO sendo aprovadas ao mesmo tempo vem depois, no
  // createIfNotRecentlyPublished (atômico no banco).
  if (republishCutoff !== null) {
    const recentlyPublished = await repos.publishedDeal.wasRecentlyPublished(offer.shopeeItemId, republishCutoff);
    if (recentlyPublished) throw new RecentlyPublishedError(settings.minDaysBeforeRepublish!);
  }

  // --- limite diário (mesma checagem, mesma fonte de verdade que trava a
  // execução do pipeline como um todo - ver dailyLimit.ts) ---
  if (await isDailyLimitReached(repos, settings, effectiveMode)) {
    throw new DailyLimitReachedError(settings.maxOffersPerDay!);
  }

  // --- reivindicação atômica: garante que só uma aprovação para esta
  // rejeição específica prossegue, mesmo com cliques duplicados no mesmo
  // botão ---
  const claimed = await repos.rejectedOffer.claimManualApproval(rejectedOfferId, approvedBy);
  if (!claimed) throw new AlreadyApprovedError();

  try {
    const existingProduct = await repos.product.findByShopeeItemId(offer.shopeeItemId);
    const priceStats = existingProduct ? await repos.priceHistory.getStats(existingProduct.id) : null;

    const affiliateLink = offer.affiliateLink ?? (await shopeeClient.getAffiliateLink(offer.shopeeItemId));
    const product = await repos.product.upsert(offer, affiliateLink);
    await repos.priceHistory.recordIfChanged(product.id, offer.currentPrice);

    const { score } = calculateDealScore({ offer, priceStats }, weights);

    // Atômico: se OUTRA rejeição (linha diferente) para este mesmo produto
    // tiver sido aprovada nesse meio-tempo, isso retorna false em vez de
    // criar uma segunda publicação para o mesmo produto.
    const created = await repos.publishedDeal.createIfNotRecentlyPublished(offer.shopeeItemId, republishCutoff, {
      productId: product.id,
      priceAtPublish: offer.currentPrice,
      dealScore: score,
      channel: channelForMode(effectiveMode),
      approvedManually: true,
      approvedBy,
      sourceRejectedOfferId: rejectedOfferId,
      ...(offer.searchCategoryId !== undefined ? { searchCategoryId: offer.searchCategoryId } : {}),
      ...(offer.searchCategoryName !== undefined ? { searchCategoryName: offer.searchCategoryName } : {}),
    });

    if (!created) {
      throw new RecentlyPublishedError(settings.minDaysBeforeRepublish ?? 0);
    }

    return { productId: product.id, dealScore: score, affiliateLink };
  } catch (err) {
    // Não deixa a rejeição "presa" como aprovada sem ter criado nada -
    // desfaz a reivindicação para o usuário poder tentar de novo (ou para
    // que a oferta volte a aparecer corretamente como pendente).
    await repos.rejectedOffer.clearManualApproval(rejectedOfferId);
    throw err;
  }
}

export class PublishedDealNotFoundError extends Error {
  constructor() {
    super("Oferta publicada não encontrada.");
    this.name = "PublishedDealNotFoundError";
  }
}

export class NotManuallyApprovedError extends Error {
  constructor() {
    super("Esta oferta não foi aprovada manualmente, então não há aprovação para desfazer.");
    this.name = "NotManuallyApprovedError";
  }
}

/**
 * Desfaz uma aprovação manual feita por engano (pedido do usuário): remove
 * a publicação e, se ela veio de uma rejeição original, faz essa rejeição
 * voltar a aparecer como pendente no painel - como se a aprovação nunca
 * tivesse acontecido.
 */
export async function revertManualApproval(repos: Repositories, publishedDealId: string): Promise<void> {
  const deal = await repos.publishedDeal.findById(publishedDealId);
  if (!deal) throw new PublishedDealNotFoundError();
  if (!deal.approvedManually) throw new NotManuallyApprovedError();

  await repos.publishedDeal.delete(publishedDealId);

  if (deal.sourceRejectedOfferId) {
    await repos.rejectedOffer.clearManualApproval(deal.sourceRejectedOfferId);
  }
}

export class UseUndoInsteadError extends Error {
  constructor() {
    super(
      'Esta oferta foi aprovada manualmente - use "Desfazer" nela, que preserva o motivo da rejeição original, em vez de criar uma nova rejeição.',
    );
    this.name = "UseUndoInsteadError";
  }
}

/**
 * O inverso de "Aprovar manualmente": rejeita uma oferta que tinha sido
 * aprovada AUTOMATICAMENTE (pelo pipeline, sem intervenção humana). Remove
 * a publicação e cria uma nova rejeição pendente com o snapshot atual do
 * produto - ela passa a aparecer normalmente em "Ofertas rejeitadas" e
 * pode, inclusive, ser aprovada de novo depois (o ciclo é reversível nos
 * dois sentidos).
 *
 * Só se aplica a ofertas aprovadas AUTOMATICAMENTE. Uma oferta aprovada
 * manualmente já tem "Desfazer" (`revertManualApproval`), que é a ação
 * correta ali porque restaura a rejeição ORIGINAL (com o motivo de verdade
 * pelo qual o sistema tinha rejeitado), em vez de criar uma genérica nova.
 */
export async function rejectApprovedOfferManually(
  repos: Repositories,
  publishedDealId: string,
  rejectedBy: string,
): Promise<void> {
  const deal = await repos.publishedDeal.findById(publishedDealId);
  if (!deal) throw new PublishedDealNotFoundError();
  if (deal.approvedManually) throw new UseUndoInsteadError();

  const offerSnapshot: RawShopeeOffer = {
    shopeeItemId: deal.shopeeItemId,
    name: deal.productName,
    url: deal.productUrl ?? "",
    currentPrice: deal.currentPrice ?? deal.priceAtPublish,
    ...(deal.productImageUrl !== null ? { imageUrl: deal.productImageUrl } : {}),
    ...(deal.previousPrice !== null ? { previousPrice: deal.previousPrice } : {}),
    ...(deal.discountPercent !== null ? { discountPercent: deal.discountPercent } : {}),
    ...(deal.rating !== null ? { rating: deal.rating } : {}),
    ...(deal.ratingCount !== null ? { ratingCount: deal.ratingCount } : {}),
    ...(deal.salesCount !== null ? { salesCount: deal.salesCount } : {}),
    ...(deal.commissionPercent !== null ? { commissionPercent: deal.commissionPercent } : {}),
    ...(deal.affiliateLink !== null ? { affiliateLink: deal.affiliateLink } : {}),
    ...(deal.shopId !== null ? { shopId: deal.shopId } : {}),
    ...(deal.searchCategoryId !== null ? { searchCategoryId: deal.searchCategoryId } : {}),
    ...(deal.searchCategoryName !== null ? { searchCategoryName: deal.searchCategoryName } : {}),
  };

  await repos.publishedDeal.delete(publishedDealId);

  await repos.rejectedOffer.createManual({
    shopeeItemId: deal.shopeeItemId,
    productName: deal.productName,
    reason: "MANUALLY_REJECTED",
    details: `Rejeitada manualmente por ${rejectedBy} (estava aprovada automaticamente).`,
    offerSnapshot: JSON.stringify(offerSnapshot),
  });
}
