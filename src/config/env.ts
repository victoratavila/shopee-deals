import "dotenv/config";
import { z } from "zod";

/**
 * Trata string vazia ("") como "não preenchido". Isso é necessário porque o
 * .env.example traz as variáveis opcionais como VAR="", e sem isso o Zod
 * tentaria validar a string vazia (e falharia) em vez de tratá-la como
 * ausente.
 */
const emptyToUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatório"),
  RUN_MODE: z.enum(["TEST", "DRY_RUN", "PRODUCTION"]).default("TEST"),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_SESSION_SECRET: z.string().min(16, "ADMIN_SESSION_SECRET deve ter pelo menos 16 caracteres"),

  // Usado pelo endpoint /api/internal/scheduler-tick, chamado por um cron
  // externo gratuito (ex: cron-job.org) em hospedagens free tier que
  // "dormem" quando ociosas e não conseguem manter um cron interno vivo.
  // Opcional: só é obrigatório se você for usar esse endpoint.
  CRON_SECRET: emptyToUndefined(z.string().min(16).optional()) as z.ZodType<string | undefined>,

  // Credenciais Shopee - opcionais até serem configuradas por você.
  SHOPEE_APP_ID: emptyToUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  SHOPEE_APP_SECRET: emptyToUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  SHOPEE_AFFILIATE_ID: emptyToUndefined(z.string().optional()) as z.ZodType<string | undefined>,
  // Só necessário se sua conta de afiliado não for do Brasil - o endpoint
  // padrão é o brasileiro (open-api.affiliate.shopee.com.br/graphql).
  SHOPEE_API_ENDPOINT: emptyToUndefined(z.string().url().optional()) as z.ZodType<string | undefined>,
});

export type Env = z.infer<typeof EnvSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}\n\nVerifique seu arquivo .env (veja .env.example).`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
