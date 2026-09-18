import type { RawShopeeOffer, RejectedOfferResult, RunMode } from "../types/domain.js";
import type { OperationalSettings } from "../config/operationalSettings.js";
import type { PriceStats } from "../pricehistory/suspiciousPrice.js";

export interface StoredProduct {
  id: string;
  shopeeItemId: string;
  currentPrice: number;
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

export interface PublishedDealRepository {
  wasRecentlyPublished(shopeeItemId: string, sinceDate: Date): Promise<boolean>;
  countPublishedSince(sinceDate: Date): Promise<number>;
  create(entry: {
    productId: string;
    priceAtPublish: number;
    dealScore: number;
    channel: "TEST" | "DRY_RUN" | "TELEGRAM" | "WHATSAPP";
    runId?: string;
    approvedManually?: boolean;
    approvedBy?: string;
  }): Promise<void>;
  /** Lista as publicações mais recentes, com dados do produto - usado no painel. */
  listRecent(limit: number): Promise<
    Array<{
      id: string;
      productName: string;
      priceAtPublish: number;
      dealScore: number;
      channel: string;
      approvedManually: boolean;
      publishedAt: Date;
    }>
  >;
}

export interface StoredRejectedOffer {
  id: string;
  shopeeItemId: string;
  productName: string | null;
  reason: string;
  details: string | null;
  offerSnapshot: string | null;
  manuallyApprovedAt: Date | null;
  createdAt: Date;
}

export interface RejectedOfferRepository {
  recordMany(runId: string, rejections: RejectedOfferResult[]): Promise<void>;
  findById(id: string): Promise<StoredRejectedOffer | null>;
  markManuallyApproved(id: string, approvedBy: string): Promise<void>;
  /** Lista as rejeições mais recentes (todas as execuções) - usado no painel. */
  listRecent(limit: number): Promise<StoredRejectedOffer[]>;
}

export interface ErrorLogRepository {
  record(entry: { runId?: string; scope: string; message: string; stack?: string; context?: unknown }): Promise<void>;
}

export interface RunRepository {
  hasActiveRun(): Promise<boolean>;
  /**
   * Marca como FAILED qualquer Run que ficou travado em RUNNING (ex: processo
   * morreu no meio da execução). Deve ser chamado uma vez na inicialização
   * da aplicação, antes do scheduler começar a aceitar novas execuções —
   * é isso que garante recuperação automática após reinício (seção 12/18).
   */
  reconcileStaleRuns(maxAgeMinutes: number): Promise<number>;
  /** Data de término da última execução finalizada (para o scheduler saber o intervalo, mesmo após reiniciar). */
  getLastFinishedAt(): Promise<Date | null>;
  create(mode: RunMode, triggeredBy: string): Promise<{ id: string }>;
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
