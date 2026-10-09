import { z } from "zod";

const IanaTimeZoneSchema = z.string().min(1).refine((timeZone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}, "Fuso horário IANA inválido");

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
  reprocessIntervalMinutes: z.number().int().min(0).default(1_440),

  operatingHoursEnabled: z.boolean().default(true),
  automationStartTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("08:00"),
  automationEndTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("22:00"),
  automationTimeZone: IanaTimeZoneSchema.default("America/Sao_Paulo"),

  republishIntervalMinutes: z.number().int().min(0).nullable().default(10_080),

  // Limiar para considerar um preço anterior "suspeito" em relação ao
  // histórico real armazenado (ver seção 8 do escopo).
  suspiciousPriceDeviationPercent: z.number().min(0).default(60),

  automationEnabled: z.boolean().default(false),
  automationResumeAt: z.string().datetime().nullable().default(null),
  schedulerRefreshRunId: z.string().nullable().default(null),
  schedulerRefreshAt: z.string().datetime().nullable().default(null),
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

export function parseOperationalSettings(input: unknown): OperationalSettings {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const stored = { ...input } as Record<string, unknown>;
    const legacyRepublishDays = stored["minDaysBeforeRepublish"];
    if (
      stored["republishIntervalMinutes"] === undefined &&
      (typeof legacyRepublishDays === "number" || legacyRepublishDays === null)
    ) {
      stored["republishIntervalMinutes"] =
        legacyRepublishDays === null ? null : legacyRepublishDays * 1_440;
    }
    delete stored["minDaysBeforeRepublish"];
    return OperationalSettingsSchema.parse(stored);
  }
  return OperationalSettingsSchema.parse(input);
}

export function defaultOperationalSettings(): OperationalSettings {
  return OperationalSettingsSchema.parse({});
}

export const SETTINGS_KEY = "operational";
