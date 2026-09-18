import { z } from "zod";

/**
 * Todas as regras de negócio configuráveis pelo painel administrativo
 * (seção 6 do escopo), sem necessidade de alterar código. Persistidas na
 * tabela `Setting` como um único JSON sob a chave "operational".
 */
export const OperationalSettingsSchema = z.object({
  minDiscountPercent: z.number().min(0).max(100).default(20),
  minPrice: z.number().min(0).default(0),
  maxPrice: z.number().min(0).default(1_000_000),
  minRating: z.number().min(0).max(5).default(4.0),
  minRatingCount: z.number().int().min(0).default(20),
  minSalesCount: z.number().int().min(0).default(10),
  minCommissionPercent: z.number().min(0).max(100).default(3),

  allowedCategories: z.array(z.string()).default([]), // vazio = todas permitidas
  blockedCategories: z.array(z.string()).default([]),

  maxOffersPerRound: z.number().int().min(1).default(10),
  maxOffersPerDay: z.number().int().min(1).default(50),
  intervalBetweenRoundsMinutes: z.number().int().min(1).default(60),

  automationStartHour: z.number().int().min(0).max(23).default(8),
  automationEndHour: z.number().int().min(0).max(23).default(22),

  minDaysBeforeRepublish: z.number().int().min(0).default(7),

  // Limiar para considerar um preço anterior "suspeito" em relação ao
  // histórico real armazenado (ver seção 8 do escopo).
  suspiciousPriceDeviationPercent: z.number().min(0).default(60),

  automationEnabled: z.boolean().default(false),
  dryRunEnabled: z.boolean().default(true),
});

export type OperationalSettings = z.infer<typeof OperationalSettingsSchema>;

export function defaultOperationalSettings(): OperationalSettings {
  return OperationalSettingsSchema.parse({});
}

export const SETTINGS_KEY = "operational";
