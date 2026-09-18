import { loadEnv } from "./config/env.js";
import { getPrismaClient } from "./db/prismaClient.js";
import { createPrismaRepositories } from "./db/prisma/createPrismaRepositories.js";
import { createShopeeClient } from "./shopee/createShopeeClient.js";
import { startScheduler, schedulerTick } from "./scheduler/scheduler.js";
import { buildWebServer } from "./web/server.js";
import { runPipeline } from "./pipeline/runPipeline.js";

const APP_VERSION = "0.1.0";

async function main() {
  const env = loadEnv();
  const prisma = getPrismaClient();
  const repos = createPrismaRepositories(prisma);

  const shopeeClient = createShopeeClient({
    runMode: env.RUN_MODE,
    ...(env.SHOPEE_APP_ID !== undefined ? { shopeeAppId: env.SHOPEE_APP_ID } : {}),
    ...(env.SHOPEE_APP_SECRET !== undefined ? { shopeeAppSecret: env.SHOPEE_APP_SECRET } : {}),
    ...(env.SHOPEE_AFFILIATE_ID !== undefined ? { shopeeAffiliateId: env.SHOPEE_AFFILIATE_ID } : {}),
    ...(env.SHOPEE_API_ENDPOINT !== undefined ? { shopeeApiEndpoint: env.SHOPEE_API_ENDPOINT } : {}),
  });

  const usingRealShopeeApi = Boolean(env.SHOPEE_APP_ID && env.SHOPEE_APP_SECRET);
  console.log(
    `[startup] RUN_MODE=${env.RUN_MODE} | Shopee: ${usingRealShopeeApi ? "credenciais configuradas" : "usando MockShopeeClient (sem credenciais)"}`,
  );

  // Recupera runs travados por reinício/crash antes de aceitar novas execuções (seção 12/18).
  const recovered = await repos.run.reconcileStaleRuns(60);
  if (recovered > 0) {
    console.log(`[startup] ${recovered} execução(ões) travada(s) foram marcadas como FAILED (recuperação após reinício)`);
  }

  const args = process.argv.slice(2);

  if (args.includes("--once")) {
    console.log("[cli] executando uma rodada manual e encerrando...");
    const result = await runPipeline({
      shopeeClient,
      repos,
      mode: env.RUN_MODE,
      triggeredBy: "cli",
    });
    console.log(JSON.stringify(result, null, 2));
    await prisma.$disconnect();
    process.exit(0);
  }

  if (args.includes("--tick")) {
    console.log("[cli] rodando um único tick do scheduler (respeita configurações) e encerrando...");
    const result = await schedulerTick({
      shopeeClient,
      repos,
      envRunMode: env.RUN_MODE,
      logger: { info: console.log, error: console.error },
    });
    console.log(result ? JSON.stringify(result, null, 2) : "Nenhuma execução disparada (condições não satisfeitas).");
    await prisma.$disconnect();
    process.exit(0);
  }

  // Modo padrão: sobe o scheduler + o painel administrativo juntos.
  const cronTask = startScheduler({
    shopeeClient,
    repos,
    envRunMode: env.RUN_MODE,
    logger: { info: console.log, error: console.error },
  });

  const app = await buildWebServer({
    prisma,
    repos,
    shopeeClient,
    envRunMode: env.RUN_MODE,
    sessionSecret: env.ADMIN_SESSION_SECRET,
    appVersion: APP_VERSION,
    ...(env.CRON_SECRET !== undefined ? { cronSecret: env.CRON_SECRET } : {}),
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  console.log(`[startup] painel administrativo disponível em http://localhost:${env.PORT}`);

  async function shutdown(signal: string) {
    console.log(`[shutdown] recebido ${signal}, encerrando com segurança...`);
    cronTask.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal] falha na inicialização:", err);
  process.exit(1);
});
