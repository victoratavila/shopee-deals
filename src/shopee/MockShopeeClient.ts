import type { ShopeeClient, SearchOffersParams, SearchOffersResult } from "./ShopeeClient.js";
import { FIXTURE_OFFERS } from "./fixtures.js";

/**
 * Implementação de fixtures/mock. Usada em TEST mode e sempre que as
 * credenciais reais (SHOPEE_APP_ID / SHOPEE_APP_SECRET) não estiverem
 * configuradas. Respeita exatamente o mesmo contrato `ShopeeClient` que a
 * implementação real vai seguir, então trocar uma pela outra não exige
 * mudanças no restante do sistema.
 */
export class MockShopeeClient implements ShopeeClient {
  async searchOffers(params: SearchOffersParams): Promise<SearchOffersResult> {
    const start = (params.page - 1) * params.pageSize;
    const end = start + params.pageSize;
    const filtered = params.category
      ? FIXTURE_OFFERS.filter((o) => o.category === params.category)
      : FIXTURE_OFFERS;

    return {
      offers: filtered.slice(start, end),
      hasNextPage: end < filtered.length,
    };
  }

  async getAffiliateLink(shopeeItemId: string): Promise<string> {
    return `https://example.invalid/affiliate/${shopeeItemId}?mock=true`;
  }
}
