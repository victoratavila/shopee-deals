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
import type { RawShopeeOffer, RejectedOfferResult, RunMode } from "../src/types/domain.js";
import type { PriceStats } from "../src/pricehistory/suspiciousPrice.js";
import { defaultOperationalSettings, type OperationalSettings } from "../src/config/operationalSettings.js";

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
}

interface FakeRejectedOffer extends StoredRejectedOffer {}

export function createInMemoryRepositories(settingsOverride?: Partial<OperationalSettings>): Repositories & {
  state: {
    products: Map<string, StoredProduct & { priceHistory: number[]; name: string }>;
    publishedDeals: FakePublishedDeal[];
    rejected: FakeRejectedOffer[];
    errors: unknown[];
    runs: { id: string; status: string }[];
  };
} {
  const state = {
    products: new Map<string, StoredProduct & { priceHistory: number[]; name: string }>(),
    publishedDeals: [] as FakePublishedDeal[],
    rejected: [] as FakeRejectedOffer[],
    errors: [] as unknown[],
    runs: [] as { id: string; status: string }[],
  };

  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const settings: OperationalSettings = { ...defaultOperationalSettings(), ...settingsOverride };

  const product: ProductRepository = {
    async findByShopeeItemId(shopeeItemId) {
      return state.products.get(shopeeItemId) ?? null;
    },
    async upsert(offer: RawShopeeOffer) {
      const existing = state.products.get(offer.shopeeItemId);
      const stored = {
        id: existing?.id ?? nextId("product"),
        shopeeItemId: offer.shopeeItemId,
        currentPrice: offer.currentPrice,
        priceHistory: existing?.priceHistory ?? [],
        name: offer.name,
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

  const publishedDeal: PublishedDealRepository = {
    async wasRecentlyPublished(shopeeItemId, sinceDate) {
      const p = state.products.get(shopeeItemId);
      if (!p) return false;
      return state.publishedDeals.some((d) => d.productId === p.id && d.publishedAt >= sinceDate);
    },
    async countPublishedSince(sinceDate) {
      return state.publishedDeals.filter((d) => d.publishedAt >= sinceDate).length;
    },
    async create(entry) {
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
      });
    },
    async listRecent(limit) {
      return state.publishedDeals
        .slice()
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, limit);
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
          createdAt: new Date(),
        });
      }
    },
    async findById(id) {
      return state.rejected.find((r) => r.id === id) ?? null;
    },
    async markManuallyApproved(id, _approvedBy) {
      const row = state.rejected.find((r) => r.id === id);
      if (row) row.manuallyApprovedAt = new Date();
    },
    async listRecent(limit) {
      return state.rejected
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
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
    async create(_mode: RunMode, _triggeredBy: string) {
      const id = nextId("run");
      state.runs.push({ id, status: "RUNNING" });
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
