import { createHash } from "node:crypto";
import type { ShopeeClient, SearchOffersParams, SearchOffersResult } from "./ShopeeClient.js";
import { ShopeeApiError } from "./ShopeeClient.js";
import type { RawShopeeOffer } from "../types/domain.js";

export interface RealShopeeClientConfig {
  appId: string;
  appSecret: string;
  affiliateId?: string;
  /**
   * Endpoint da Affiliate Open API. Varia por país (ex: .com.br para Brasil,
   * .vn para Vietnã). Ver painel de afiliado > Open API para confirmar o
   * domínio correto da sua conta.
   */
  endpoint?: string;
}

/** Formato de erro retornado pela Shopee Affiliate Open API. */
interface ShopeeGraphQLError {
  message: string;
  extensions?: { code?: number };
}

interface ProductOfferNode {
  itemId: string | number;
  shopId?: string | number;
  productName: string;
  productLink: string;
  offerLink: string;
  imageUrl?: string;
  priceMin?: string;
  priceMax?: string;
  priceDiscountRate?: number;
  ratingStar?: string;
  sales?: number;
  commissionRate?: string;
  productCatIds?: number[];
}

function parseOptionalNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  return Number(value);
}

/**
 * Implementação real da Shopee Affiliate Open API (GraphQL, assinatura
 * SHA256 simples - apesar do nome "Authorization: SHA256 ...", NÃO é HMAC:
 * é um hash SHA256 direto da concatenação appId+timestamp+payload+secret).
 * Referência pública: https://open-api.affiliate.shopee.com.br/graphql
 *
 * LIMITAÇÕES CONHECIDAS DA API PÚBLICA (importante para calibrar os filtros
 * no painel depois que essa integração entrar no ar):
 * - Não existe campo de "quantidade de avaliações" (ratingCount) no
 *   productOfferV2 - só a nota média (ratingStar). Por padrão o filtro
 *   `minRatingCount` do sistema é 20, o que rejeitaria TODAS as ofertas
 *   reais por falta desse dado. Assim que esta integração for ativada,
 *   ajuste `minRatingCount` para 0 ou `null` no painel (Configurações),
 *   ou essa regra fica sem efeito prático.
 * - Não existe um campo de "preço anterior" explícito - ele é estimado a
 *   partir de `priceDiscountRate` (ver `estimatePreviousPrice` abaixo).
 *   Isso é uma aproximação, não o preço "de fato" antes da promoção.
 */
export class RealShopeeClient implements ShopeeClient {
  private readonly endpoint: string;

  constructor(private readonly config: RealShopeeClientConfig) {
    this.endpoint = config.endpoint ?? "https://open-api.affiliate.shopee.com.br/graphql";
  }

  private sign(timestamp: number, payload: string): string {
    const base = `${this.config.appId}${timestamp}${payload}${this.config.appSecret}`;
    return createHash("sha256").update(base).digest("hex");
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ query, variables });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(timestamp, payload);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `SHA256 Credential=${this.config.appId}, Timestamp=${timestamp}, Signature=${signature}`,
        },
        body: payload,
      });
    } catch (err) {
      // Falha de rede/DNS/timeout do fetch - deixamos o withRetry do pipeline
      // decidir se tenta de novo (erro genérico é tratado como retryable).
      throw new ShopeeApiError("Falha de rede ao chamar a Shopee Affiliate API", "TIMEOUT", true, err);
    }

    if (response.status === 429) {
      throw new ShopeeApiError("Rate limit atingido na Shopee Affiliate API", "RATE_LIMIT", true);
    }
    if (response.status >= 500) {
      throw new ShopeeApiError(`Shopee retornou erro ${response.status}`, "TIMEOUT", true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ShopeeApiError("Credenciais inválidas para a Shopee Affiliate API", "AUTH", false);
    }

    let body: { data?: T; errors?: ShopeeGraphQLError[] };
    try {
      body = (await response.json()) as { data?: T; errors?: ShopeeGraphQLError[] };
    } catch (err) {
      throw new ShopeeApiError("Resposta inválida (não é JSON) da Shopee Affiliate API", "INVALID_RESPONSE", true, err);
    }

    if (body.errors && body.errors.length > 0) {
      const first = body.errors[0]!;
      const code = first.extensions?.code;
      // Códigos documentados publicamente pela Shopee Affiliate Open API.
      if (code === 10030) throw new ShopeeApiError(first.message, "RATE_LIMIT", true);
      if (code === 10020 || code === 10031 || code === 10032 || code === 10033 || code === 10034) {
        throw new ShopeeApiError(first.message, "AUTH", false);
      }
      if (code === 10035) {
        throw new ShopeeApiError(
          "Sua conta ainda não tem acesso liberado ao Shopee Affiliate Open API Platform (aguardando aprovação da Shopee).",
          "AUTH",
          false,
        );
      }
      throw new ShopeeApiError(first.message, "UNKNOWN", false);
    }

    if (!body.data) {
      throw new ShopeeApiError("Resposta da Shopee sem campo 'data'", "INVALID_RESPONSE", true);
    }

    return body.data;
  }

  /** Estimativa do preço anterior a partir do desconto - a API não expõe o valor original diretamente. */
  private static estimatePreviousPrice(currentPrice: number, discountRatePercent?: number): number | undefined {
    if (!discountRatePercent || discountRatePercent <= 0 || discountRatePercent >= 100) return undefined;
    return Number((currentPrice / (1 - discountRatePercent / 100)).toFixed(2));
  }

  private static mapNodeToOffer(node: ProductOfferNode): RawShopeeOffer {
    const currentPrice = Number(node.priceMin ?? node.priceMax ?? 0);
    const discountPercent = parseOptionalNumber(node.priceDiscountRate);
    const rating = parseOptionalNumber(node.ratingStar);
    const salesCount = parseOptionalNumber(node.sales);
    const commissionRate = parseOptionalNumber(node.commissionRate);
    const commissionPercent =
      commissionRate !== undefined ? commissionRate * 100 : undefined;
    const previousPrice = RealShopeeClient.estimatePreviousPrice(currentPrice, discountPercent);

    return {
      shopeeItemId: node.itemId === undefined || node.itemId === null ? "" : String(node.itemId),
      ...(node.shopId !== undefined ? { shopId: String(node.shopId) } : {}),
      name: typeof node.productName === "string" ? node.productName : "",
      url: typeof node.productLink === "string" ? node.productLink : "",
      ...(node.imageUrl !== undefined ? { imageUrl: node.imageUrl } : {}),
      ...(node.productCatIds?.[0] !== undefined ? { category: String(node.productCatIds[0]) } : {}),
      currentPrice,
      ...(previousPrice !== undefined ? { previousPrice } : {}),
      ...(discountPercent !== undefined ? { discountPercent } : {}),
      ...(rating !== undefined ? { rating } : {}),
      // ratingCount não é exposto pela API pública - ver aviso na doc da classe.
      ...(salesCount !== undefined ? { salesCount } : {}),
      ...(commissionPercent !== undefined ? { commissionPercent } : {}),
      // offerLink já vem com o tracking do seu Affiliate ID aplicado.
      affiliateLink: node.offerLink,
    };
  }

  async searchOffers(params: SearchOffersParams): Promise<SearchOffersResult> {
    const query = `
      query GetProductOffers($page: Int, $limit: Int, $keyword: String) {
        productOfferV2(page: $page, limit: $limit, keyword: $keyword) {
          nodes {
            itemId
            shopId
            productName
            productLink
            offerLink
            imageUrl
            priceMin
            priceMax
            priceDiscountRate
            ratingStar
            sales
            commissionRate
            productCatIds
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const data = await this.request<{
      productOfferV2: { nodes: ProductOfferNode[]; pageInfo: { hasNextPage: boolean } };
    }>(query, {
      page: params.page,
      limit: params.pageSize,
      ...(params.keyword !== undefined ? { keyword: params.keyword }
        : params.category !== undefined ? { keyword: params.category }
        : {}),
    });

    const offers = data.productOfferV2.nodes.map(RealShopeeClient.mapNodeToOffer);
    for (let index = offers.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [offers[index], offers[swapIndex]] = [offers[swapIndex]!, offers[index]!];
    }

    return {
      offers,
      hasNextPage: data.productOfferV2.pageInfo.hasNextPage,
    };
  }

  async getAffiliateLink(shopeeItemId: string): Promise<string> {
    // Fluxo normal: o link de afiliado já vem em `offerLink` na própria busca
    // (ver mapNodeToOffer), então este método só é usado em casos avulsos
    // (ex: aprovar manualmente uma oferta muito antiga sem link salvo).
    // Buscamos o produto de novo pelo itemId para pegar o link original...
    const lookupQuery = `
      query GetProductByItemId($itemId: Int64) {
        productOfferV2(itemId: $itemId, limit: 1) {
          nodes { productLink }
        }
      }
    `;
    const lookup = await this.request<{ productOfferV2: { nodes: { productLink: string }[] } }>(lookupQuery, {
      itemId: Number(shopeeItemId),
    });
    const productLink = lookup.productOfferV2.nodes[0]?.productLink;
    if (!productLink) {
      throw new ShopeeApiError(`Produto ${shopeeItemId} não encontrado na Shopee`, "INVALID_RESPONSE", false);
    }

    // ...e então geramos o link curto rastreável a partir dele.
    const shortLinkMutation = `
      mutation GenerateLink($originUrl: String!) {
        generateShortLink(input: { originUrl: $originUrl }) {
          shortLink
        }
      }
    `;
    const result = await this.request<{ generateShortLink: { shortLink: string } }>(shortLinkMutation, {
      originUrl: productLink,
    });
    return result.generateShortLink.shortLink;
  }
}
