import type { RawShopeeOffer } from "../types/domain.js";

export interface SearchOffersParams {
  page: number;
  pageSize: number;
  category?: string;
}

export interface SearchOffersResult {
  offers: RawShopeeOffer[];
  hasNextPage: boolean;
}

/**
 * Contrato que qualquer implementação de acesso à Shopee deve seguir.
 * O core (filtros, deal score, histórico) depende SOMENTE desta interface,
 * nunca da implementação concreta (mock ou real). Isso permite trocar o
 * mock pela integração real sem alterar o restante do sistema.
 */
export interface ShopeeClient {
  /** Busca uma página de ofertas. Deve lançar ShopeeApiError em falhas. */
  searchOffers(params: SearchOffersParams): Promise<SearchOffersResult>;

  /** Obtém (ou gera) o link de afiliado para um item específico. */
  getAffiliateLink(shopeeItemId: string): Promise<string>;
}

export class ShopeeApiError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "RATE_LIMIT"
      | "TIMEOUT"
      | "INVALID_RESPONSE"
      | "AUTH"
      | "UNKNOWN",
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ShopeeApiError";
  }
}
