import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import { ShopeeApiError } from "../shopee/ShopeeClient.js";
import type { Repositories } from "../db/repositories.js";
import type { RawShopeeOffer, RejectedOfferResult, RunMode } from "../types/domain.js";
import { evaluateOffer, toRejectedOfferResult } from "../filters/evaluateOffer.js";
import { checkSuspiciousPrice } from "../pricehistory/suspiciousPrice.js";
import { calculateDealScore, DEFAULT_DEAL_SCORE_WEIGHTS, type DealScoreWeights } from "../dealscore/calculateDealScore.js";
import { withRetry, withTimeout } from "../utils/retry.js";

export class ConcurrentRunError extends Error {
  constructor() {
    super("Já existe uma execução em andamento. Aguarde ela terminar antes de iniciar outra.");
    this.name = "ConcurrentRunError";
  }
}

export interface AcceptedOfferSummary {
  offer: RawShopeeOffer;
  dealScore: number;
  affiliateLink: string;
}

export interface PipelineResult {
  runId: string;
  mode: RunMode;
  productsFound: number;
  productsFiltered: number;
  dealsSelected: number;
  dealsPublished: number;
  errorsCount: number;
  durationMs: number;
  accepted: AcceptedOfferSummary[];
  rejected: RejectedOfferResult[];
}

export interface RunPipelineOptions {
  shopeeClient: ShopeeClient;
  repos: Repositories;
  mode: RunMode;
  triggeredBy: string; // "scheduler" | "manual" | admin user id
  maxPages?: number; // proteção extra contra loop infinito de paginação
  dealScoreWeights?: DealScoreWeights;
  /** timeout por chamada à Shopee, em ms (seção 5 - confiabilidade) */
  shopeeTimeoutMs?: number;
  /** tentativas máximas por chamada à Shopee, com exponential backoff */
  shopeeMaxAttempts?: number;
}

/** Decide se vale a pena tentar de novo uma falha da Shopee. */
function isRetryableShopeeError(err: unknown): boolean {
  if (err instanceof ShopeeApiError) return err.retryable;
  return true; // erros de rede/timeout genéricos: vale tentar de novo
}

/**
 * Converte o modo de execução no canal de publicação a ser gravado.
 * Em PRODUCTION, ainda não existe canal externo real (WhatsApp/Telegram
 * só chegam na Fase 7) — por ora gravamos como DRY_RUN para não perder
 * o registro do que "teria sido" publicado.
 */
function channelForMode(mode: RunMode): "TEST" | "DRY_RUN" {
  return mode === "TEST" ? "TEST" : "DRY_RUN";
}
export { channelForMode };

/** Empacota o resultado de rejeição junto com o snapshot completo da oferta,
 * necessário para permitir aprovação manual depois pelo painel. */
function rejectWithSnapshot(
  offer: RawShopeeOffer,
  evaluation: { accepted: false; reason: RejectedOfferResult["reason"]; details?: string },
): RejectedOfferResult {
  return { ...toRejectedOfferResult(offer, evaluation), offerSnapshot: offer };
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineResult> {
  const { shopeeClient, repos, mode, triggeredBy } = opts;
  const maxPages = opts.maxPages ?? 20;
  const weights = opts.dealScoreWeights ?? DEFAULT_DEAL_SCORE_WEIGHTS;
  const shopeeTimeoutMs = opts.shopeeTimeoutMs ?? 10_000;
  const shopeeMaxAttempts = opts.shopeeMaxAttempts ?? 3;

  const fetchOffersPage = (page: number) =>
    withRetry(
      () => withTimeout(() => shopeeClient.searchOffers({ page, pageSize: 50 }), shopeeTimeoutMs, "shopee.searchOffers"),
      { maxAttempts: shopeeMaxAttempts, isRetryable: isRetryableShopeeError },
    );

  const fetchAffiliateLink = (shopeeItemId: string) =>
    withRetry(
      () => withTimeout(() => shopeeClient.getAffiliateLink(shopeeItemId), shopeeTimeoutMs, "shopee.getAffiliateLink"),
      { maxAttempts: shopeeMaxAttempts, isRetryable: isRetryableShopeeError },
    );

  if (await repos.run.hasActiveRun()) {
    throw new ConcurrentRunError();
  }

  const startedAt = Date.now();
  const { id: runId } = await repos.run.create(mode, triggeredBy);

  const settings = await repos.settings.getOperationalSettings();
  const republishCutoff = new Date(Date.now() - settings.minDaysBeforeRepublish * 24 * 60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const seenInRound = new Set<string>();
  const accepted: AcceptedOfferSummary[] = [];
  const rejected: RejectedOfferResult[] = [];
  let productsFound = 0;
  let errorsCount = 0;

  const alreadyPublishedToday = await repos.publishedDeal.countPublishedSince(todayStart);
  let publishedTodayCount = alreadyPublishedToday;

  try {
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage && page <= maxPages) {
      const result = await fetchOffersPage(page);
      hasNextPage = result.hasNextPage;
      productsFound += result.offers.length;

      for (const offer of result.offers) {
        try {
          // --- duplicidade dentro da própria rodada ---
          if (seenInRound.has(offer.shopeeItemId)) {
            rejected.push(rejectWithSnapshot(offer, { accepted: false, reason: "DUPLICATE" }));
            continue;
          }
          seenInRound.add(offer.shopeeItemId);

          // --- limites de quantidade (seção 6/12) ---
          if (accepted.length >= settings.maxOffersPerRound) {
            rejected.push(rejectWithSnapshot(offer, { accepted: false, reason: "ROUND_LIMIT_REACHED" }));
            continue;
          }
          if (publishedTodayCount + accepted.length >= settings.maxOffersPerDay) {
            rejected.push(rejectWithSnapshot(offer, { accepted: false, reason: "DAILY_LIMIT_REACHED" }));
            continue;
          }

          const existingProduct = await repos.product.findByShopeeItemId(offer.shopeeItemId);

          const recentlyPublished = await repos.publishedDeal.wasRecentlyPublished(
            offer.shopeeItemId,
            republishCutoff,
          );

          const priceStats = existingProduct ? await repos.priceHistory.getStats(existingProduct.id) : null;
          const suspicious = checkSuspiciousPrice(offer, priceStats, settings.suspiciousPriceDeviationPercent);

          const evaluation = evaluateOffer(offer, settings, {
            recentlyPublished,
            isDuplicateInRound: false, // já tratado acima
            isSuspiciousPrice: suspicious.suspicious,
            ...(suspicious.reason !== undefined ? { suspiciousReason: suspicious.reason } : {}),
          });

          if (!evaluation.accepted) {
            rejected.push(rejectWithSnapshot(offer, evaluation));
            continue;
          }

          // --- oferta aceita: persistir produto, histórico e "publicação" ---
          const affiliateLink = offer.affiliateLink ?? (await fetchAffiliateLink(offer.shopeeItemId));
          const product = await repos.product.upsert(offer, affiliateLink);
          await repos.priceHistory.recordIfChanged(product.id, offer.currentPrice);

          const { score } = calculateDealScore({ offer, priceStats }, weights);

          await repos.publishedDeal.create({
            productId: product.id,
            priceAtPublish: offer.currentPrice,
            dealScore: score,
            channel: channelForMode(mode),
            runId,
          });

          accepted.push({ offer, dealScore: score, affiliateLink });
        } catch (err) {
          errorsCount++;
          await repos.errorLog.record({
            runId,
            scope: "pipeline.offer",
            message: err instanceof Error ? err.message : String(err),
            ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
            context: { shopeeItemId: offer.shopeeItemId },
          });
          // Uma falha em um produto não interrompe a rodada (seção 5/22).
        }
      }

      page++;
    }
  } catch (err) {
    errorsCount++;
    await repos.errorLog.record({
      runId,
      scope: "pipeline.search",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    });
  }

  await repos.rejectedOffer.recordMany(runId, rejected);

  const durationMs = Date.now() - startedAt;
  const status = errorsCount === 0 ? "SUCCESS" : accepted.length > 0 ? "PARTIAL" : "FAILED";

  await repos.run.finish(runId, {
    status,
    productsFound,
    productsFiltered: rejected.length,
    dealsSelected: accepted.length,
    dealsPublished: accepted.length, // sem canal externo real ainda (Fase 7)
    errorsCount,
    durationMs,
  });

  return {
    runId,
    mode,
    productsFound,
    productsFiltered: rejected.length,
    dealsSelected: accepted.length,
    dealsPublished: accepted.length,
    errorsCount,
    durationMs,
    accepted,
    rejected,
  };
}
