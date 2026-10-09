/**
 * Tipos de domínio. Estes tipos representam o produto "cru" retornado pela
 * camada de busca (API real ou mock) ANTES de qualquer filtro ou score.
 */
export interface RawShopeeOffer {
  shopeeItemId: string;
  shopId?: string;
  name: string;
  url: string;
  imageUrl?: string;
  category?: string;
  /** Categoria configurada que originou a busca, diferente da categoria da Shopee. */
  searchCategoryId?: string;
  searchCategoryName?: string;

  currentPrice: number;
  previousPrice?: number;
  discountPercent?: number;

  rating?: number;
  ratingCount?: number;
  salesCount?: number;
  commissionPercent?: number;

  /** Presente somente se a fonte já trouxer um link de afiliado pronto */
  affiliateLink?: string;
}

export type RejectionReason =
  | "DISCOUNT_BELOW_MINIMUM"
  | "RATING_BELOW_MINIMUM"
  | "REVIEWS_BELOW_MINIMUM"
  | "SALES_BELOW_MINIMUM"
  | "COMMISSION_BELOW_MINIMUM"
  | "PRICE_OUT_OF_RANGE"
  | "CATEGORY_BLOCKED"
  | "CATEGORY_NOT_ALLOWED"
  | "RECENTLY_PUBLISHED"
  | "SUSPICIOUS_PRICE"
  | "DUPLICATE"
  | "INVALID_DATA"
  | "DAILY_LIMIT_REACHED"
  | "ROUND_LIMIT_REACHED"
  | "MANUALLY_REJECTED";

export interface RejectedOfferResult {
  shopeeItemId: string;
  productName?: string;
  reason: RejectionReason;
  details?: string;
  /** Oferta completa no momento da rejeição - permite aprovar manualmente depois. */
  offerSnapshot?: RawShopeeOffer;
}

export interface AcceptedOffer {
  offer: RawShopeeOffer;
  dealScore: number;
  scoreBreakdown: Record<string, number>;
}

export type RunMode = "TEST" | "DRY_RUN" | "PRODUCTION";
