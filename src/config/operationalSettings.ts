import { z } from "zod";

/**
 * Todas as regras de negócio configuráveis pelo painel administrativo
 * (seção 6 do escopo), sem necessidade de alterar código. Persistidas na
 * tabela `Setting` como um único JSON sob a chave "operational".
 *
 * Os limiares de filtro (min/max) aceitam `null`, que significa "sem
 * limite" - o painel expõe isso como um botão em cada campo.
 */
export const OperationalSettingsSchema = z.object({
  minDiscountPercent: z.number().min(0).max(100).nullable().default(20),
  minPrice: z.number().min(0).nullable().default(0),
  maxPrice: z.number().min(0).nullable().default(1_000_000),
  minRating: z.number().min(0).max(5).nullable().default(4.0),
  minRatingCount: z.number().int().min(0).nullable().default(20),
  minSalesCount: z.number().int().min(0).nullable().default(10),
  minCommissionPercent: z.number().min(0).max(100).nullable().default(3),

  allowedCategories: z.array(z.string()).default([]), // vazio = todas permitidas
  blockedCategories: z.array(z.string()).default([]),

  maxOffersPerRound: z.number().int().min(1).nullable().default(10),
  maxOffersPerDay: z.number().int().min(1).nullable().default(50),
  // Quantas ofertas no máximo são BUSCADAS na Shopee por rodada, antes de
  // qualquer filtro/aprovação/rejeição - diferente de maxOffersPerRound
  // (que limita quantas são APROVADAS). Serve para controlar quantas
  // ofertas passam nos critérios. O escopo (rodada inteira ou categoria) é
  // escolhido em searchLimitScope.
  maxOffersFetchedPerRound: z.number().int().min(1).nullable().default(null),
  searchLimitScope: z.enum(["ROUND", "CATEGORY"]).default("ROUND"),
  intervalBetweenRoundsMinutes: z.number().int().min(1).default(60),

  automationStartHour: z.number().int().min(0).max(23).default(8),
  automationEndHour: z.number().int().min(0).max(23).default(22),

  minDaysBeforeRepublish: z.number().int().min(0).nullable().default(7),

  // Limiar para considerar um preço anterior "suspeito" em relação ao
  // histórico real armazenado (ver seção 8 do escopo).
  suspiciousPriceDeviationPercent: z.number().min(0).default(60),

  automationEnabled: z.boolean().default(false),
  dryRunEnabled: z.boolean().default(true),

  // Busca por categorias/palavras-chave configuráveis
  searchMode: z.enum(["ALL_PRODUCTS", "CATEGORIES"]).default("ALL_PRODUCTS"),
  keywordCategories: z.array(z.object({
    id: z.string(),
    name: z.string().min(1),
    keywords: z.array(z.string()),
    selected: z.boolean().default(false),
  })).default([]),
});

export type OperationalSettings = z.infer<typeof OperationalSettingsSchema>;

export function defaultOperationalSettings(): OperationalSettings {
  return OperationalSettingsSchema.parse({});
}

export const SETTINGS_KEY = "operational";
