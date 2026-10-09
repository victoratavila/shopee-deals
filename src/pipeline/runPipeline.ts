import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import { ShopeeApiError } from "../shopee/ShopeeClient.js";
import type { Repositories } from "../db/repositories.js";
import { ConcurrentRunError } from "../db/repositories.js";
import type { RawShopeeOffer, RejectedOfferResult, RunMode } from "../types/domain.js";
import { evaluateOffer, toRejectedOfferResult } from "../filters/evaluateOffer.js";
import { checkSuspiciousPrice } from "../pricehistory/suspiciousPrice.js";
import { calculateDealScore, DEFAULT_DEAL_SCORE_WEIGHTS, type DealScoreWeights } from "../dealscore/calculateDealScore.js";
import { withRetry, withTimeout } from "../utils/retry.js";
import { isDailyLimitReached, DailyLimitReachedError } from "./dailyLimit.js";

// Reexportado por compatibilidade - o restante do projeto (server.ts,
// scheduler.ts, testes) importa esses erros a partir daqui.
export { ConcurrentRunError, DailyLimitReachedError };

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

  const fetchOffersPage = (page: number, keyword?: string) =>
    withRetry(
      () => withTimeout(
        () => shopeeClient.searchOffers({ page, pageSize: 50, ...(keyword !== undefined ? { keyword } : {}) }),
        shopeeTimeoutMs,
        "shopee.searchOffers",
      ),
      { maxAttempts: shopeeMaxAttempts, isRetryable: isRetryableShopeeError },
    );

  const fetchAffiliateLink = (shopeeItemId: string) =>
    withRetry(
      () => withTimeout(() => shopeeClient.getAffiliateLink(shopeeItemId), shopeeTimeoutMs, "shopee.getAffiliateLink"),
      { maxAttempts: shopeeMaxAttempts, isRetryable: isRetryableShopeeError },
    );

  const startedAt = Date.now();

  // Checagem do limite diário ANTES de sequer criar o Run: se já foi
  // atingido, nenhuma execução acontece - nem automática, nem manual -
  // até o usuário aumentar o limite ou o dia virar. Isso troca o
  // comportamento antigo (rejeitar ofertas individualmente e guardar cada
  // rejeição com motivo DAILY_LIMIT_REACHED) por travar a execução como um
  // todo, sem gerar nenhum dado no banco para as ofertas que nem chegaram
  // a ser buscadas.
  const settings = await repos.settings.getOperationalSettings();
  if (await isDailyLimitReached(repos, settings, mode)) {
    throw new DailyLimitReachedError(settings.maxOffersPerDay!);
  }

  // repos.run.create() é atômico (adquire o lock e cria o Run numa operação
  // só) - lança ConcurrentRunError se já houver uma execução em andamento.
  // Não fazemos mais um "hasActiveRun() ? throw : create()" separado, porque
  // isso deixava uma brecha entre a checagem e a criação onde duas
  // execuções concorrentes (scheduler + manual, por exemplo) podiam passar
  // pela checagem ao mesmo tempo.
  const { id: runId } = await repos.run.create(mode, triggeredBy);

  // null = sem restrição de republicação (o produto pode ser publicado de novo a qualquer momento).
  const republishCutoff =
    settings.republishIntervalMinutes !== null
      ? new Date(Date.now() - settings.republishIntervalMinutes * 60 * 1000)
      : null;
  const reprocessCutoff = new Date(
    Date.now() - settings.reprocessIntervalMinutes * 60 * 1000,
  );

  const seenInRound = new Set<string>();
  const accepted: AcceptedOfferSummary[] = [];
  const rejected: RejectedOfferResult[] = [];
  let productsFound = 0;
  let errorsCount = 0;
  // Determina os termos de busca. O teto pode ser compartilhado pela rodada
  // toda ou reaplicado separadamente a cada categoria selecionada.
  // No modo global, palavras repetidas entre categorias são consultadas uma vez.
  const categoryScopedLimit =
    settings.searchMode === "CATEGORIES" && settings.searchLimitScope === "CATEGORY";
  const searchTargets: Array<{
    keyword?: string;
    groupId: string;
    limit: number | null;
    categoryId?: string;
    categoryName?: string;
  }> = [];
  const globallyScheduledKeywords = new Set<string>();
  if (settings.searchMode === "CATEGORIES" && settings.keywordCategories.length > 0) {
    for (const [categoryIndex, category] of settings.keywordCategories.entries()) {
      if (!category.selected) continue;
      const uniqueKeywords = new Map<string, string>();
      for (const keyword of category.keywords) {
        const trimmed = keyword.trim();
        if (trimmed.length > 0 && !uniqueKeywords.has(trimmed.toLowerCase())) {
          uniqueKeywords.set(trimmed.toLowerCase(), trimmed);
        }
      }
      const keywords = [...uniqueKeywords.values()];
      const groupId = categoryScopedLimit ? `category-${categoryIndex}` : "round";
      for (const [keywordIndex, keyword] of keywords.entries()) {
        const normalizedKeyword = keyword.toLowerCase();
        if (!categoryScopedLimit && globallyScheduledKeywords.has(normalizedKeyword)) continue;
        globallyScheduledKeywords.add(normalizedKeyword);
        const categoryLimit =
          categoryScopedLimit && settings.maxOffersFetchedPerRound !== null && keywords.length > 0
            ? Math.floor(settings.maxOffersFetchedPerRound / keywords.length) +
              (keywordIndex < settings.maxOffersFetchedPerRound % keywords.length ? 1 : 0)
            : settings.maxOffersFetchedPerRound;
        searchTargets.push({
          keyword,
          groupId: categoryScopedLimit ? `${groupId}-keyword-${keywordIndex}` : groupId,
          limit: categoryLimit,
          categoryId: `keyword:${normalizedKeyword}`,
          categoryName: keyword,
        });
      }
    }
  }

  // Sem categorias ou palavras-chave selecionadas, usar a busca geral.
  if (searchTargets.length === 0) {
    searchTargets.push({
      groupId: "round",
      limit: settings.maxOffersFetchedPerRound,
      categoryId: "all-products",
      categoryName: "Busca geral",
    });
  }

  const fetchedByGroup = new Map<string, number>();
  for (const { keyword, groupId, limit, categoryId, categoryName } of searchTargets) {
    try {
      let page = 1;
      let hasNextPage = true;

      while (hasNextPage && page <= maxPages) {
        const fetchedInGroup = fetchedByGroup.get(groupId) ?? 0;
        if (limit !== null && fetchedInGroup >= limit) {
          break;
        }

        const result = await fetchOffersPage(page, keyword);
        hasNextPage = result.hasNextPage;

        let offersThisPage = result.offers;
        if (limit !== null) {
          const remaining = limit - fetchedInGroup;
          if (offersThisPage.length > remaining) {
            offersThisPage = offersThisPage.slice(0, remaining);
            hasNextPage = false;
          }
        }
        if (categoryId !== undefined && categoryName !== undefined) {
          offersThisPage = offersThisPage.map((offer) => ({
            ...offer,
            searchCategoryId: categoryId,
            searchCategoryName: categoryName,
          }));
        }
        fetchedByGroup.set(groupId, fetchedInGroup + offersThisPage.length);
        productsFound += offersThisPage.length;

        const offersToCheck: RawShopeeOffer[] = [];
        for (const offer of offersThisPage) {
          if (seenInRound.has(offer.shopeeItemId)) continue;
          offersToCheck.push(offer);
        }
        const lastProcessedAtByItemId =
          await repos.product.findLastProcessedAtByShopeeItemIds(
            offersToCheck.map((offer) => offer.shopeeItemId),
          );
        for (const offer of offersToCheck) {
          seenInRound.add(offer.shopeeItemId);
        }

        for (const offer of offersToCheck) {
          try {
            // A mesma oferta pode vir de várias páginas/keywords na rodada.
            // Ela já foi contabilizada pela primeira ocorrência e não gera
            // uma rejeição repetida.
            const lastProcessedAt = lastProcessedAtByItemId.get(offer.shopeeItemId);
            if (lastProcessedAt !== undefined && lastProcessedAt > reprocessCutoff) {
              continue;
            }

            const existingProduct = await repos.product.findByShopeeItemId(offer.shopeeItemId);
            const recentlyPublished =
              republishCutoff !== null
                ? await repos.publishedDeal.wasRecentlyPublished(offer.shopeeItemId, republishCutoff)
                : false;
            const priceStats = existingProduct ? await repos.priceHistory.getStats(existingProduct.id) : null;
            const suspicious = checkSuspiciousPrice(offer, priceStats, settings.suspiciousPriceDeviationPercent);
            const evaluation = evaluateOffer(offer, settings, {
              recentlyPublished,
              isDuplicateInRound: false,
              isSuspiciousPrice: suspicious.suspicious,
              ...(suspicious.reason !== undefined ? { suspiciousReason: suspicious.reason } : {}),
            });

            if (!evaluation.accepted) {
              rejected.push(rejectWithSnapshot(offer, evaluation));
              continue;
            }

            if (settings.maxOffersPerRound !== null && accepted.length >= settings.maxOffersPerRound) {
              rejected.push(rejectWithSnapshot(offer, {
                accepted: false,
                reason: "ROUND_LIMIT_REACHED",
                details: `Limite de ${settings.maxOffersPerRound} ofertas aprovadas por rodada atingido`,
              }));
              continue;
            }

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
              ...(offer.searchCategoryId !== undefined ? { searchCategoryId: offer.searchCategoryId } : {}),
              ...(offer.searchCategoryName !== undefined ? { searchCategoryName: offer.searchCategoryName } : {}),
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
            // Uma falha em um produto não interrompe a rodada.
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
        ...(keyword !== undefined ? { context: { keyword } } : {}),
      });
      // Uma falha em uma palavra-chave não interrompe as demais.
    }
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
