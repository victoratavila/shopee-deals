import type {
  Repositories,
  ProductRepository,
  PriceHistoryRepository,
  PublishedDealRepository,
  RejectedOfferRepository,
  ErrorLogRepository,
  RunRepository,
  SettingsRepository,
  StoredProduct,
  StoredRejectedOffer,
} from "../src/db/repositories.js";
import { ConcurrentRunError } from "../src/db/repositories.js";
import type { RawShopeeOffer, RejectedOfferResult, RunMode } from "../src/types/domain.js";
import type { PriceStats } from "../src/pricehistory/suspiciousPrice.js";
import { defaultOperationalSettings, type OperationalSettings } from "../src/config/operationalSettings.js";

type FakeProduct = StoredProduct & {
  priceHistory: number[];
  name: string;
  url?: string;
  imageUrl?: string;
  affiliateLink?: string;
  previousPrice?: number;
  discountPercent?: number;
  rating?: number;
  ratingCount?: number;
  salesCount?: number;
  commissionPercent?: number;
  shopId?: string;
};

interface FakePublishedDeal {
  id: string;
  productId: string;
  productName: string;
  priceAtPublish: number;
  dealScore: number;
  publishedAt: Date;
  channel: string;
  approvedManually: boolean;
  approvedBy?: string;
  sourceRejectedOfferId?: string;
  searchCategoryId?: string;
  searchCategoryName?: string;
}

interface FakeRejectedOffer extends StoredRejectedOffer {}

interface FakeRun {
  id: string;
  status: string;
  triggeredBy: string;
  startedAt: Date;
}

export function createInMemoryRepositories(settingsOverride?: Partial<OperationalSettings>): Repositories & {
  state: {
    products: Map<string, FakeProduct>;
    publishedDeals: FakePublishedDeal[];
    rejected: FakeRejectedOffer[];
    errors: unknown[];
    runs: FakeRun[];
  };
} {
  const state = {
    products: new Map<string, FakeProduct>(),
    publishedDeals: [] as FakePublishedDeal[],
    rejected: [] as FakeRejectedOffer[],
    errors: [] as unknown[],
    runs: [] as FakeRun[],
  };

  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const settings: OperationalSettings = { ...defaultOperationalSettings(), ...settingsOverride };

  const product: ProductRepository = {
    async findByShopeeItemId(shopeeItemId) {
      return state.products.get(shopeeItemId) ?? null;
    },
    async upsert(offer: RawShopeeOffer, affiliateLink: string) {
      const existing = state.products.get(offer.shopeeItemId);
      const stored: FakeProduct = {
        id: existing?.id ?? nextId("product"),
        shopeeItemId: offer.shopeeItemId,
        currentPrice: offer.currentPrice,
        priceHistory: existing?.priceHistory ?? [],
        name: offer.name,
        url: offer.url,
        ...(offer.imageUrl !== undefined ? { imageUrl: offer.imageUrl } : {}),
        affiliateLink,
        ...(offer.previousPrice !== undefined ? { previousPrice: offer.previousPrice } : {}),
        ...(offer.discountPercent !== undefined ? { discountPercent: offer.discountPercent } : {}),
        ...(offer.rating !== undefined ? { rating: offer.rating } : {}),
        ...(offer.ratingCount !== undefined ? { ratingCount: offer.ratingCount } : {}),
        ...(offer.salesCount !== undefined ? { salesCount: offer.salesCount } : {}),
        ...(offer.commissionPercent !== undefined ? { commissionPercent: offer.commissionPercent } : {}),
        ...(offer.shopId !== undefined ? { shopId: offer.shopId } : {}),
      };
      state.products.set(offer.shopeeItemId, stored);
      return stored;
    },
  };

  const priceHistory: PriceHistoryRepository = {
    async getStats(productId): Promise<PriceStats | null> {
      const entry = [...state.products.values()].find((p) => p.id === productId);
      if (!entry || entry.priceHistory.length < 2) return null;
      const prices = entry.priceHistory;
      return {
        lowestPrice: Math.min(...prices),
        averagePrice: prices.reduce((a, b) => a + b, 0) / prices.length,
        lastKnownPrice: prices[prices.length - 1] ?? null,
        sampleSize: prices.length,
      };
    },
    async recordIfChanged(productId, newPrice) {
      const entry = [...state.products.values()].find((p) => p.id === productId);
      if (!entry) return;
      const last = entry.priceHistory[entry.priceHistory.length - 1];
      if (last !== newPrice) entry.priceHistory.push(newPrice);
    },
  };

  const pushDeal = (entry: {
    productId: string;
    priceAtPublish: number;
    dealScore: number;
    channel: string;
    approvedManually?: boolean;
    approvedBy?: string;
    sourceRejectedOfferId?: string;
    searchCategoryId?: string;
    searchCategoryName?: string;
  }) => {
    const p = [...state.products.values()].find((prod) => prod.id === entry.productId);
    state.publishedDeals.push({
      id: nextId("deal"),
      productId: entry.productId,
      productName: p?.name ?? "desconhecido",
      priceAtPublish: entry.priceAtPublish,
      dealScore: entry.dealScore,
      publishedAt: new Date(),
      channel: entry.channel,
      approvedManually: entry.approvedManually ?? false,
      ...(entry.approvedBy !== undefined ? { approvedBy: entry.approvedBy } : {}),
      ...(entry.sourceRejectedOfferId !== undefined ? { sourceRejectedOfferId: entry.sourceRejectedOfferId } : {}),
      ...(entry.searchCategoryId !== undefined ? { searchCategoryId: entry.searchCategoryId } : {}),
      ...(entry.searchCategoryName !== undefined ? { searchCategoryName: entry.searchCategoryName } : {}),
    });
  };

  const publishedDeal: PublishedDealRepository = {
    async wasRecentlyPublished(shopeeItemId, sinceDate) {
      const p = state.products.get(shopeeItemId);
      if (!p) return false;
      return state.publishedDeals.some((d) => d.productId === p.id && d.publishedAt >= sinceDate);
    },
    async countPublishedSince(sinceDate, channel) {
      return state.publishedDeals.filter((d) => d.publishedAt >= sinceDate && (channel === undefined || d.channel === channel)).length;
    },
    async create(entry) {
      pushDeal(entry);
    },
    async createIfNotRecentlyPublished(shopeeItemId, sinceDate, entry) {
      // Sem await entre a checagem e a escrita - emula a transação
      // Serializable real (ver PrismaPublishedDealRepository).
      if (sinceDate !== null) {
        const p = state.products.get(shopeeItemId);
        const recentlyPublished = p
          ? state.publishedDeals.some((d) => d.productId === p.id && d.publishedAt >= sinceDate)
          : false;
        if (recentlyPublished) return false;
      }
      pushDeal(entry);
      return true;
    },
    async findById(id) {
      const d = state.publishedDeals.find((deal) => deal.id === id);
      if (!d) return null;
      const p = [...state.products.values()].find((prod) => prod.id === d.productId);
      return {
        id: d.id,
        productId: d.productId,
        shopeeItemId: p?.shopeeItemId ?? "",
        approvedManually: d.approvedManually,
        sourceRejectedOfferId: d.sourceRejectedOfferId ?? null,
        approvedBy: d.approvedBy ?? null,
        searchCategoryId: d.searchCategoryId ?? null,
        searchCategoryName: d.searchCategoryName ?? null,
        priceAtPublish: d.priceAtPublish,
        dealScore: d.dealScore,
        channel: d.channel,
        publishedAt: d.publishedAt,
        productName: p?.name ?? d.productName,
        productUrl: p?.url ?? null,
        productImageUrl: p?.imageUrl ?? null,
        currentPrice: p?.currentPrice ?? null,
        previousPrice: p?.previousPrice ?? null,
        discountPercent: p?.discountPercent ?? null,
        rating: p?.rating ?? null,
        ratingCount: p?.ratingCount ?? null,
        salesCount: p?.salesCount ?? null,
        commissionPercent: p?.commissionPercent ?? null,
        affiliateLink: p?.affiliateLink ?? null,
        shopId: p?.shopId ?? null,
      };
    },
    async delete(id) {
      const idx = state.publishedDeals.findIndex((deal) => deal.id === id);
      if (idx !== -1) state.publishedDeals.splice(idx, 1);
    },
    async deleteAll() {
      const count = state.publishedDeals.length;
      state.publishedDeals = [];
      return count;
    },
    async listRecent(limit) {
      return state.publishedDeals
        .slice()
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, limit)
        .map((d) => {
          const p = [...state.products.values()].find((prod) => prod.id === d.productId);
          return {
            id: d.id,
            productName: d.productName,
            productImageUrl: p?.imageUrl ?? null,
            affiliateLink: p?.affiliateLink ?? null,
            priceAtPublish: d.priceAtPublish,
            dealScore: d.dealScore,
            channel: d.channel,
            approvedManually: d.approvedManually,
            searchCategoryId: d.searchCategoryId ?? null,
            searchCategoryName: d.searchCategoryName ?? null,
            publishedAt: d.publishedAt,
          };
        });
    },
  };

  const rejectedOffer: RejectedOfferRepository = {
    async recordMany(_runId, rejections: RejectedOfferResult[]) {
      for (const r of rejections) {
        state.rejected.push({
          id: nextId("rejected"),
          shopeeItemId: r.shopeeItemId,
          productName: r.productName ?? null,
          reason: r.reason,
          details: r.details ?? null,
          offerSnapshot: r.offerSnapshot !== undefined ? JSON.stringify(r.offerSnapshot) : null,
          manuallyApprovedAt: null,
          manuallyApprovedBy: null,
          createdAt: new Date(),
        });
      }
    },
    async findById(id) {
      return state.rejected.find((r) => r.id === id) ?? null;
    },
    async createManual(entry) {
      const row = {
        id: nextId("rejected"),
        shopeeItemId: entry.shopeeItemId,
        productName: entry.productName ?? null,
        reason: entry.reason,
        details: entry.details ?? null,
        offerSnapshot: entry.offerSnapshot,
        manuallyApprovedAt: null,
        manuallyApprovedBy: null,
        createdAt: new Date(),
      };
      state.rejected.push(row);
      return row;
    },
    async claimManualApproval(id, approvedBy) {
      const row = state.rejected.find((r) => r.id === id);
      if (!row || row.manuallyApprovedAt !== null) return false;
      row.manuallyApprovedAt = new Date();
      row.manuallyApprovedBy = approvedBy;
      return true;
    },
    async clearManualApproval(id) {
      const row = state.rejected.find((r) => r.id === id);
      if (row) {
        row.manuallyApprovedAt = null;
        row.manuallyApprovedBy = null;
      }
    },
    async countPending(since) {
      return state.rejected.filter(
        (r) => r.manuallyApprovedAt === null && (since === undefined || r.createdAt >= since),
      ).length;
    },
    async listRecent(limit, since) {
      return state.rejected
        .filter((r) => since === undefined || r.createdAt >= since)
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },
    async deleteAllPending() {
      const before = state.rejected.length;
      state.rejected = state.rejected.filter((r) => r.manuallyApprovedAt !== null);
      return before - state.rejected.length;
    },
    async deleteAll() {
      const count = state.rejected.length;
      state.rejected = [];
      return count;
    },
  };

  const errorLog: ErrorLogRepository = {
    async record(entry) {
      state.errors.push(entry);
    },
  };

  const run: RunRepository = {
    async hasActiveRun() {
      return state.runs.some((r) => r.status === "RUNNING");
    },
    async create(_mode: RunMode, triggeredBy: string) {
      // Sem await entre a checagem e a escrita - emula a atomicidade da
      // transação real do PrismaRunRepository (checagem e criação como uma
      // operação só, sem brecha para uma segunda chamada concorrente).
      if (state.runs.some((r) => r.status === "RUNNING")) {
        throw new ConcurrentRunError();
      }
      const id = nextId("run");
      state.runs.push({ id, status: "RUNNING", triggeredBy, startedAt: new Date() });
      return { id };
    },
    async reconcileStaleRuns() {
      let count = 0;
      for (const r of state.runs) {
        if (r.status === "RUNNING") {
          r.status = "FAILED";
          count++;
        }
      }
      return count;
    },
    async getLastFinishedAt() {
      return null; // fakes de teste não precisam simular isso por padrão
    },
    async finish(runId, stats) {
      const r = state.runs.find((run) => run.id === runId);
      if (r) r.status = stats.status;
    },
    async countRunsSince(sinceDate) {
      const runsInRange = state.runs.filter((r) => r.startedAt >= sinceDate);
      const schedulerCount = runsInRange.filter((r) => r.triggeredBy === "scheduler").length;
      const manualCount = runsInRange.filter((r) => r.triggeredBy.startsWith("manual:")).length;
      return { schedulerCount, manualCount, totalCount: runsInRange.length };
    },
  };

  const settingsRepo: SettingsRepository = {
    async getOperationalSettings() {
      return settings;
    },
  };

  return {
    product,
    priceHistory,
    publishedDeal,
    rejectedOffer,
    errorLog,
    run,
    settings: settingsRepo,
    state,
  };
}
