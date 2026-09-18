import type { ShopeeClient } from "./ShopeeClient.js";
import { MockShopeeClient } from "./MockShopeeClient.js";
import { RealShopeeClient } from "./RealShopeeClient.js";

export interface CreateShopeeClientOptions {
  runMode: "TEST" | "DRY_RUN" | "PRODUCTION";
  shopeeAppId?: string;
  shopeeAppSecret?: string;
  shopeeAffiliateId?: string;
  shopeeApiEndpoint?: string;
}

/**
 * Ponto único de decisão: usa o mock se estivermos em TEST mode OU se as
 * credenciais reais ainda não estiverem configuradas. Isso garante que o
 * resto do sistema nunca fica bloqueado por falta de credenciais.
 */
export function createShopeeClient(opts: CreateShopeeClientOptions): ShopeeClient {
  const hasRealCredentials = Boolean(opts.shopeeAppId && opts.shopeeAppSecret);

  if (opts.runMode === "TEST" || !hasRealCredentials) {
    return new MockShopeeClient();
  }

  return new RealShopeeClient({
    appId: opts.shopeeAppId!,
    appSecret: opts.shopeeAppSecret!,
    ...(opts.shopeeAffiliateId !== undefined ? { affiliateId: opts.shopeeAffiliateId } : {}),
    ...(opts.shopeeApiEndpoint !== undefined ? { endpoint: opts.shopeeApiEndpoint } : {}),
  });
}
