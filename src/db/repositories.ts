import type { RawShopeeOffer, RejectedOfferResult, RejectionReason, RunMode } from "../types/domain.js";
import type { OperationalSettings } from "../config/operationalSettings.js";
import type { PriceStats } from "../pricehistory/suspiciousPrice.js";

export interface StoredProduct {
  id: string;
  shopeeItemId: string;
  currentPrice: number;
}

/**
 * Lançado por RunRepository.create() quando já existe uma execução em
 * andamento. A checagem é atômica no nível do banco (ver PrismaRunRepository),
 * o que garante que scheduler, execução manual e cliques duplicados nunca
 * rodem dois pipelines ao mesmo tempo - e portanto nunca aprovem/publiquem
 * a mesma oferta duas vezes por essa via.
 */
export class ConcurrentRunError extends Error {
  constructor() {
    super("Já existe uma execução em andamento. Aguarde ela terminar antes de iniciar outra.");
    this.name = "ConcurrentRunError";
  }
}

/**
 * Todas as interfaces abaixo são os "ports" que o pipeline (núcleo) usa.
 * As implementações concretas (Prisma) ficam em src/db/prisma/*.
 * Isso permite testar o pipeline inteiro com fakes em memória, sem banco.
 */
export interface ProductRepository {
  findByShopeeItemId(shopeeItemId: string): Promise<StoredProduct | null>;
  upsert(offer: RawShopeeOffer, affiliateLink: string): Promise<StoredProduct>;
}

export interface PriceHistoryRepository {
  getStats(productId: string): Promise<PriceStats | null>;
  /** Só grava um novo ponto se o preço realmente mudou em relação ao último registro. */
  recordIfChanged(productId: string, newPrice: number): Promise<void>;
}

/**
 * Dados completos de uma publicação, incluindo os campos do Product
 * associado. Usado tanto na listagem simplificada quanto no modal de
 * detalhes (seção 3) - todos esses campos já existiam no banco (Product +
 * PublishedDeal), só não eram todos retornados por findById antes.
 */
export interface StoredPublishedDeal {
  id: string;
  productId: string;
  shopeeItemId: string;
  approvedManually: boolean;
  sourceRejectedOfferId: string | null;
  approvedBy: string | null;
  searchCategoryId: string | null;
  searchCategoryName: string | null;
  priceAtPublish: number;
  dealScore: number;
  channel: string;
  publishedAt: Date;
  productName: string;
  productUrl: string | null;
  productImageUrl: string | null;
  currentPrice: number | null;
  previousPrice: number | null;
  discountPercent: number | null;
  rating: number | null;
  ratingCount: number | null;
  salesCount: number | null;
  commissionPercent: number | null;
  affiliateLink: string | null;
  shopId: string | null;
}

export interface PublishedDealRepository {
  wasRecentlyPublished(shopeeItemId: string, sinceDate: Date): Promise<boolean>;
  /** `channel`, se informado, conta só publicações daquele canal (usado pelo
   *  limite diário - TEST só conta TEST, DRY_RUN só conta DRY_RUN, etc., pra
   *  não misturar contagens de modos diferentes). */
  countPublishedSince(sinceDate: Date, channel?: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP"): Promise<number>;
  create(entry: {
    productId: string;
    priceAtPublish: number;
    dealScore: number;
    channel: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP";
    runId?: string;
    approvedManually?: boolean;
    approvedBy?: string;
    sourceRejectedOfferId?: string;
    searchCategoryId?: string;
    searchCategoryName?: string;
  }): Promise<void>;
  /**
   * Versão atômica de "checar se foi publicado recentemente + criar" numa
   * operação só. Usada pela aprovação manual: sem isso, duas linhas de
   * REJEIÇÃO DIFERENTES para o MESMO PRODUTO (ex: rejeitado em duas
   * rodadas distintas, ainda sem ser aprovado nenhuma vez) poderiam ser
   * aprovadas quase ao mesmo tempo - cada uma passaria pela checagem
   * "publicado recentemente?" antes de a outra ter terminado de criar sua
   * publicação, gerando duas entradas para o mesmo produto. `create()`
   * sozinho não protege contra isso porque checagem e escrita são feitas
   * em chamadas separadas. Retorna `false` (e não cria nada) se já havia
   * uma publicação para este produto dentro da janela informada.
   */
  createIfNotRecentlyPublished(
    shopeeItemId: string,
    sinceDate: Date | null,
    entry: {
      productId: string;
      priceAtPublish: number;
      dealScore: number;
      channel: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP";
      runId?: string;
      approvedManually?: boolean;
      approvedBy?: string;
      sourceRejectedOfferId?: string;
      searchCategoryId?: string;
      searchCategoryName?: string;
    },
  ): Promise<boolean>;
  findById(id: string): Promise<StoredPublishedDeal | null>;
  /** Remove a publicação - usado para desfazer uma aprovação manual feita por engano. */
  delete(id: string): Promise<void>;
  /**
   * Apaga TODAS as publicações, sem exceção. Só deve ser chamado quando o
   * modo efetivo não é PRODUCTION (a rota que usa isso já garante essa
   * checagem) - existe pra ajudar a limpar o banco entre rodadas de teste.
   */
  deleteAll(): Promise<number>;
  /** Lista as publicações mais recentes, com dados do produto - usado no painel. */
  listRecent(limit: number): Promise<
    Array<{
      id: string;
      productName: string;
      productImageUrl: string | null;
      affiliateLink: string | null;
      priceAtPublish: number;
      dealScore: number;
      channel: string;
      approvedManually: boolean;
      searchCategoryId: string | null;
      searchCategoryName: string | null;
      publishedAt: Date;
    }>
  >;
}

export interface StoredRejectedOffer {
  id: string;
  shopeeItemId: string;
  productName: string | null;
  reason: RejectionReason;
  details: string | null;
  offerSnapshot: string | null;
  manuallyApprovedAt: Date | null;
  manuallyApprovedBy: string | null;
  createdAt: Date;
}

export interface RejectedOfferRepository {
  recordMany(runId: string, rejections: RejectedOfferResult[]): Promise<void>;
  /**
   * Cria uma única rejeição manual, sem Run associado - usada quando um
   * administrador rejeita pelo painel uma oferta que já tinha sido
   * aprovada (automática ou manualmente). Diferente de `recordMany`, que
   * sempre registra o resultado de uma execução do pipeline.
   */
  createManual(entry: {
    shopeeItemId: string;
    productName?: string;
    reason: RejectionReason;
    details?: string;
    offerSnapshot: string;
  }): Promise<StoredRejectedOffer>;
  /** Conta quantas rejeições PENDENTES existem desde uma data - usado pro
   *  contador do painel não travar no teto do "limit" da listagem (mesmo
   *  bug relatado para as ofertas aprovadas). */
  countPending(since?: Date): Promise<number>;
  findById(id: string): Promise<StoredRejectedOffer | null>;
  /**
   * Tenta "reivindicar" a rejeição para aprovação manual de forma atômica:
   * só marca manuallyApprovedAt se ele ainda estiver null. Retorna `false`
   * se outra chamada já reivindicou primeiro (ex: dois cliques rápidos no
   * botão "Aprovar") - isso evita criar duas publicações para a mesma
   * rejeição.
   */
  claimManualApproval(id: string, approvedBy: string): Promise<boolean>;
  /** Desfaz a marcação de aprovação manual, fazendo a oferta voltar a aparecer como rejeitada pendente. */
  clearManualApproval(id: string): Promise<void>;
  /** Lista as rejeições mais recentes (todas as execuções) - usado no painel.
   *  `since`, se informado, filtra no banco (não no app) por createdAt >= since. */
  listRecent(limit: number, since?: Date): Promise<StoredRejectedOffer[]>;
  /**
   * Apaga todas as rejeições PENDENTES (ainda não aprovadas manualmente),
   * para limpar o banco. As já aprovadas manualmente NÃO são apagadas por
   * aqui - elas são referenciadas por PublishedDeal.sourceRejectedOfferId
   * e o botão "Desfazer" depende de encontrá-las. Retorna quantas linhas
   * foram removidas.
   */
  deleteAllPending(): Promise<number>;
  /**
   * Apaga TODAS as rejeições, incluindo as já aprovadas manualmente (isso é
   * seguro aqui porque essa rota só é chamada junto com PublishedDeal.deleteAll(),
   * que já apaga as publicações que dependiam delas). Só deve ser chamado
   * fora do modo PRODUCTION.
   */
  deleteAll(): Promise<number>;
}

export interface ErrorLogRepository {
  record(entry: { runId?: string; scope: string; message: string; stack?: string; context?: unknown }): Promise<void>;
}

export interface RunRepository {
  hasActiveRun(): Promise<boolean>;
  /**
   * Marca como FAILED qualquer Run que ficou travado em RUNNING (ex: processo
   * morreu no meio da execução), e libera o lock de concorrência. Deve ser
   * chamado uma vez na inicialização da aplicação, antes do scheduler
   * começar a aceitar novas execuções — um processo recém-iniciado nunca
   * tem uma execução legitimamente ativa, então o lock é sempre liberado
   * aqui, independente da idade do Run (seção 12/18).
   */
  reconcileStaleRuns(maxAgeMinutes: number): Promise<number>;
  /** Data de término da última execução finalizada (para o scheduler saber o intervalo, mesmo após reiniciar). */
  getLastFinishedAt(): Promise<Date | null>;
  /**
   * Cria um novo Run de forma ATÔMICA: adquire o lock de concorrência e cria
   * o registro numa única operação. Lança ConcurrentRunError se já existir
   * uma execução em andamento - isso é o que impede o scheduler e uma
   * execução manual (ou dois cliques rápidos) de rodarem ao mesmo tempo e
   * aprovarem/publicarem a mesma oferta duas vezes.
   */
  create(mode: RunMode, triggeredBy: string): Promise<{ id: string }>;
  /** Finaliza o Run e libera o lock de concorrência, na mesma operação. */
  finish(
    runId: string,
    stats: {
      status: "SUCCESS" | "FAILED" | "PARTIAL";
      productsFound: number;
      productsFiltered: number;
      dealsSelected: number;
      dealsPublished: number;
      errorsCount: number;
      durationMs: number;
    },
  ): Promise<void>;
  /**
   * Conta quantas buscas (execuções do pipeline) aconteceram desde uma
   * data, separando por origem - reaproveita o histórico de Run já
   * existente (cada Run já representa uma busca real), sem precisar de
   * nenhum contador/armazenamento novo. "scheduler" = disparado
   * automaticamente pelo cron; "manual" = clique em "Executar agora"
   * (triggeredBy começa com "manual:"); "total" = todas as execuções no
   * período, incluindo outras origens (ex: CLI).
   */
  countRunsSince(sinceDate: Date): Promise<{ schedulerCount: number; manualCount: number; totalCount: number }>;
}

export interface SettingsRepository {
  getOperationalSettings(): Promise<OperationalSettings>;
}

export interface Repositories {
  product: ProductRepository;
  priceHistory: PriceHistoryRepository;
  publishedDeal: PublishedDealRepository;
  rejectedOffer: RejectedOfferRepository;
  errorLog: ErrorLogRepository;
  run: RunRepository;
  settings: SettingsRepository;
}
