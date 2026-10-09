import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { RealShopeeClient } from "../src/shopee/RealShopeeClient.js";
import { ShopeeApiError } from "../src/shopee/ShopeeClient.js";

const config = { appId: "APP123", appSecret: "SECRET456" };

function mockFetchOnce(status: number, jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    status,
    json: async () => jsonBody,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RealShopeeClient - assinatura", () => {
  it("assina a requisição com SHA256(appId + timestamp + payload + secret)", async () => {
    const fetchMock = mockFetchOnce(200, {
      data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } },
    });

    const client = new RealShopeeClient(config);
    await client.searchOffers({ page: 1, pageSize: 10 });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const authHeader = (options.headers as Record<string, string>)["Authorization"]!;
    const match = authHeader.match(/Credential=(.+), Timestamp=(\d+), Signature=([a-f0-9]+)/);
    expect(match).not.toBeNull();

    const [, credential, timestamp, signature] = match!;
    expect(credential).toBe("APP123");

    const expectedSignature = createHash("sha256")
      .update(`APP123${timestamp}${options.body as string}SECRET456`)
      .digest("hex");
    expect(signature).toBe(expectedSignature);
  });
});

describe("RealShopeeClient - mapeamento de ofertas", () => {
  it("mapeia os campos da API para RawShopeeOffer corretamente", async () => {
    mockFetchOnce(200, {
      data: {
        productOfferV2: {
          nodes: [
            {
              itemId: 987654321,
              shopId: 111,
              productName: "Produto Teste",
              productLink: "https://shopee.com.br/produto-teste",
              offerLink: "https://s.shopee.com.br/abc123",
              imageUrl: "https://img.shopee.com.br/x.jpg",
              priceMin: "49.90",
              priceMax: "49.90",
              priceDiscountRate: 50,
              ratingStar: "4.8",
              sales: 1200,
              commissionRate: "0.08",
              productCatIds: [100182],
            },
          ],
          pageInfo: { hasNextPage: true },
        },
      },
    });

    const client = new RealShopeeClient(config);
    const result = await client.searchOffers({ page: 1, pageSize: 10 });

    expect(result.hasNextPage).toBe(true);
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(offer.shopeeItemId).toBe("987654321");
    expect(offer.currentPrice).toBe(49.9);
    expect(offer.discountPercent).toBe(50);
    expect(offer.previousPrice).toBeCloseTo(99.8, 1); // 49.90 / (1 - 0.5)
    expect(offer.rating).toBe(4.8);
    expect(offer.salesCount).toBe(1200);
    expect(offer.commissionPercent).toBeCloseTo(8, 5); // 0.08 -> 8%
    expect(offer.affiliateLink).toBe("https://s.shopee.com.br/abc123");
  });

  it("envia a palavra-chave configurada à consulta GraphQL da Shopee", async () => {
    const fetchMock = mockFetchOnce(200, {
      data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } },
    });

    const client = new RealShopeeClient(config);
    await client.searchOffers({ page: 1, pageSize: 50, keyword: "Fone bluetooth" });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(options.body as string) as {
      variables: { keyword?: string };
    };
    expect(requestBody.variables.keyword).toBe("Fone bluetooth");
  });
});

describe("RealShopeeClient - classificação de erros", () => {
  it("HTTP 429 vira ShopeeApiError RATE_LIMIT retryable", async () => {
    mockFetchOnce(429, {});
    const client = new RealShopeeClient(config);

    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: "RATE_LIMIT",
      retryable: true,
    });
  });

  it("HTTP 401 vira ShopeeApiError AUTH não-retryable", async () => {
    mockFetchOnce(401, {});
    const client = new RealShopeeClient(config);

    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: "AUTH",
      retryable: false,
    });
  });

  it("código de erro GraphQL 10035 (sem acesso liberado) vira AUTH não-retryable", async () => {
    mockFetchOnce(200, {
      errors: [{ message: "no access", extensions: { code: 10035 } }],
    });
    const client = new RealShopeeClient(config);

    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toBeInstanceOf(ShopeeApiError);
    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: "AUTH",
      retryable: false,
    });
  });

  it("código de erro GraphQL 10030 (rate limit) é retryable", async () => {
    mockFetchOnce(200, {
      errors: [{ message: "rate limited", extensions: { code: 10030 } }],
    });
    const client = new RealShopeeClient(config);

    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: "RATE_LIMIT",
      retryable: true,
    });
  });

  it("falha de rede (fetch rejeita) vira ShopeeApiError TIMEOUT retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const client = new RealShopeeClient(config);

    await expect(client.searchOffers({ page: 1, pageSize: 10 })).rejects.toMatchObject({
      kind: "TIMEOUT",
      retryable: true,
    });
  });
});
