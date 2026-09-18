import type { RawShopeeOffer } from "../types/domain.js";

/**
 * Dados 100% fictícios usados apenas em TEST mode e nos testes automatizados.
 * Nenhum valor aqui representa produtos ou preços reais da Shopee.
 */
export const FIXTURE_OFFERS: RawShopeeOffer[] = [
  {
    shopeeItemId: "FIXTURE-001",
    shopId: "SHOP-A",
    name: "Fone de Ouvido Bluetooth (fictício)",
    url: "https://example.invalid/produto/fixture-001",
    imageUrl: "https://example.invalid/img/001.jpg",
    category: "eletronicos",
    currentPrice: 59.9,
    previousPrice: 99.9,
    discountPercent: 40,
    rating: 4.7,
    ratingCount: 1200,
    salesCount: 5400,
    commissionPercent: 8,
  },
  {
    shopeeItemId: "FIXTURE-002",
    shopId: "SHOP-B",
    name: "Suporte de Celular Ajustável (fictício)",
    url: "https://example.invalid/produto/fixture-002",
    imageUrl: "https://example.invalid/img/002.jpg",
    category: "acessorios",
    currentPrice: 19.9,
    previousPrice: 21.9,
    discountPercent: 9,
    rating: 4.2,
    ratingCount: 80,
    salesCount: 300,
    commissionPercent: 5,
  },
  {
    shopeeItemId: "FIXTURE-003",
    shopId: "SHOP-C",
    name: "Oferta suspeita (fictício - desconto inflado)",
    url: "https://example.invalid/produto/fixture-003",
    imageUrl: "https://example.invalid/img/003.jpg",
    category: "eletronicos",
    currentPrice: 49.9,
    previousPrice: 499.9, // inconsistente de propósito, para testar detecção de suspeita
    discountPercent: 90,
    rating: 3.9,
    ratingCount: 15,
    salesCount: 20,
    commissionPercent: 12,
  },
];
