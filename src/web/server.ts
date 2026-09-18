import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Repositories } from "../db/repositories.js";
import type { ShopeeClient } from "../shopee/ShopeeClient.js";
import type { RunMode } from "../types/domain.js";
import { createAdminAuthService } from "./adminAuth.js";
import { OperationalSettingsSchema } from "../config/operationalSettings.js";
import { runPipeline, ConcurrentRunError } from "../pipeline/runPipeline.js";
import {
  approveRejectedOfferManually,
  RejectedOfferNotFoundError,
  AlreadyApprovedError,
  MissingSnapshotError,
} from "../pipeline/approveRejectedOffer.js";
import { resolveEffectiveMode, schedulerTick } from "../scheduler/scheduler.js";

declare module "@fastify/session" {
  interface FastifySessionObject {
    adminId?: string;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebServerDeps {
  prisma: PrismaClient;
  repos: Repositories;
  shopeeClient: ShopeeClient;
  envRunMode: RunMode;
  sessionSecret: string;
  appVersion: string;
  /** Se definido, habilita POST /api/internal/scheduler-tick protegido por este segredo. */
  cronSecret?: string;
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const KillSwitchSchema = z.object({
  action: z.enum(["pause", "resume", "force_dry_run"]),
});

export async function buildWebServer(deps: WebServerDeps): Promise<FastifyInstance> {
  const { prisma, repos, shopeeClient, envRunMode, sessionSecret, appVersion, cronSecret } = deps;
  const app = Fastify({ logger: true, trustProxy: true });
  const authService = createAdminAuthService(prisma);

  await app.register(fastifyHelmet);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: sessionSecret,
    cookie: { secure: process.env["NODE_ENV"] === "production", httpOnly: true, sameSite: "lax" },
  });
  await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });
  // Login tem limite mais restrito, para dificultar brute force (seção 17).
  await app.register(
    async (instance) => {
      await instance.register(fastifyRateLimit, { max: 5, timeWindow: "1 minute" });
      instance.post("/api/login", async (request, reply) => {
        const parsed = LoginSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Dados de login inválidos" });
        }
        const admin = await authService.verifyCredentials(parsed.data.email, parsed.data.password);
        if (!admin) {
          return reply.code(401).send({ error: "E-mail ou senha incorretos" });
        }
        request.session.adminId = admin.id;
        return reply.send({ ok: true, email: admin.email });
      });
    },
  );

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/",
  });

  app.post("/api/logout", async (request, reply) => {
    await request.session.destroy();
    return reply.send({ ok: true });
  });

  app.get("/api/health", async (_request, reply) => {
    let dbOk = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    return reply.send({ status: dbOk ? "ok" : "degraded", database: dbOk, version: appVersion });
  });

  // Endpoint pensado para hospedagens gratuitas que "dormem" quando ociosas
  // (ex: Render free tier) e por isso não conseguem manter um node-cron
  // interno funcionando o tempo todo. Um serviço de cron externo GRATUITO
  // (ex: cron-job.org) chama esta rota a cada poucos minutos: isso acorda
  // a aplicação E dispara um tick do scheduler, que só executa de fato se
  // as condições normais (horário, kill switch, intervalo) permitirem.
  // Protegido por segredo compartilhado, não por sessão de admin.
  app.post("/api/internal/scheduler-tick", async (request, reply) => {
    if (!cronSecret) {
      return reply.code(404).send({ error: "Endpoint não habilitado (CRON_SECRET não configurado)" });
    }
    const providedSecret = request.headers["x-cron-secret"];
    if (providedSecret !== cronSecret) {
      return reply.code(401).send({ error: "Segredo inválido" });
    }
    const result = await schedulerTick({
      shopeeClient,
      repos,
      envRunMode,
      logger: { info: (m) => request.log.info(m), error: (m, e) => request.log.error({ err: e }, m) },
    });
    return reply.send({ ranPipeline: result !== null, result });
  });

  // --- A partir daqui, todas as rotas exigem autenticação ---
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/api/login") || request.url.startsWith("/api/health")) return;
    if (request.url.startsWith("/api/internal/")) return; // protegido por CRON_SECRET, não por sessão
    if (!request.url.startsWith("/api/")) return; // arquivos estáticos não exigem login aqui (proteja no proxy/produção se necessário)
    if (!request.session.adminId) {
      return reply.code(401).send({ error: "Não autenticado" });
    }
  });

  app.get("/api/dashboard", async (_request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    const hasActiveRun = await repos.run.hasActiveRun();
    const lastFinishedAt = await repos.run.getLastFinishedAt();
    const effectiveMode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);

    const recentRuns = await prisma.run.findMany({ orderBy: { startedAt: "desc" }, take: 5 });

    return reply.send({
      version: appVersion,
      automationEnabled: settings.automationEnabled,
      dryRunEnabled: settings.dryRunEnabled,
      effectiveMode,
      hasActiveRun,
      lastFinishedAt,
      operatingHours: { start: settings.automationStartHour, end: settings.automationEndHour },
      recentRuns,
    });
  });

  app.get("/api/settings", async (_request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    return reply.send(settings);
  });

  app.put("/api/settings", async (request, reply) => {
    const parsed = OperationalSettingsSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Configurações inválidas", details: parsed.error.issues });
    }
    const current = await repos.settings.getOperationalSettings();
    const merged = OperationalSettingsSchema.parse({ ...current, ...parsed.data });

    // repos.settings aqui é a interface (port); em produção é PrismaSettingsRepository,
    // que expõe também saveOperationalSettings.
    const settingsRepo = repos.settings as unknown as {
      saveOperationalSettings: (s: typeof merged, updatedBy?: string) => Promise<void>;
    };
    await settingsRepo.saveOperationalSettings(merged, request.session.adminId);

    return reply.send(merged);
  });

  app.post("/api/run-now", async (request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    const mode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
    try {
      const result = await runPipeline({
        shopeeClient,
        repos,
        mode,
        triggeredBy: `manual:${request.session.adminId}`,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof ConcurrentRunError) {
        return reply.code(409).send({ error: err.message });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Falha ao executar a rodada manual" });
    }
  });

  app.post("/api/kill-switch", async (request, reply) => {
    const parsed = KillSwitchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Ação inválida" });
    }
    const current = await repos.settings.getOperationalSettings();
    const settingsRepo = repos.settings as unknown as {
      saveOperationalSettings: (s: typeof current, updatedBy?: string) => Promise<void>;
    };

    let updated = current;
    if (parsed.data.action === "pause") {
      updated = { ...current, automationEnabled: false };
    } else if (parsed.data.action === "resume") {
      updated = { ...current, automationEnabled: true };
    } else if (parsed.data.action === "force_dry_run") {
      updated = { ...current, dryRunEnabled: true };
    }

    await settingsRepo.saveOperationalSettings(updated, request.session.adminId);
    return reply.send(updated);
  });

  app.get("/api/runs", async (request, reply) => {
    const limit = Math.min(Number((request.query as Record<string, string>)["limit"] ?? 20), 100);
    const runs = await prisma.run.findMany({ orderBy: { startedAt: "desc" }, take: limit });
    return reply.send(runs);
  });

  app.get("/api/runs/:id/rejections", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rejections = await prisma.rejectedOffer.findMany({ where: { runId: id }, orderBy: { createdAt: "desc" } });
    return reply.send(rejections);
  });

  // Todas as rejeições recentes, de qualquer execução - o que alimenta a
  // aba "Ofertas rejeitadas" do painel (seção 14).
  app.get("/api/rejections", async (request, reply) => {
    const limit = Math.min(Number((request.query as Record<string, string>)["limit"] ?? 30), 100);
    const rejections = await repos.rejectedOffer.listRecent(limit);
    // Nunca devolve o offerSnapshot bruto pro front — só o que a UI precisa mostrar.
    return reply.send(
      rejections.map((r) => ({
        id: r.id,
        shopeeItemId: r.shopeeItemId,
        productName: r.productName,
        reason: r.reason,
        details: r.details,
        canApprove: r.offerSnapshot !== null && r.manuallyApprovedAt === null,
        manuallyApprovedAt: r.manuallyApprovedAt,
        createdAt: r.createdAt,
      })),
    );
  });

  // Reverte manualmente uma rejeição automática (seção 14 - intervenção humana).
  app.post("/api/rejections/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const settings = await repos.settings.getOperationalSettings();
    const effectiveMode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);

    try {
      const result = await approveRejectedOfferManually({
        rejectedOfferId: id,
        repos,
        shopeeClient,
        approvedBy: request.session.adminId!,
        effectiveMode,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof RejectedOfferNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof AlreadyApprovedError) return reply.code(409).send({ error: err.message });
      if (err instanceof MissingSnapshotError) return reply.code(422).send({ error: err.message });
      request.log.error(err);
      return reply.code(500).send({ error: "Falha ao aprovar a oferta manualmente" });
    }
  });

  app.get("/api/deals", async (request, reply) => {
    const limit = Math.min(Number((request.query as Record<string, string>)["limit"] ?? 20), 100);
    const deals = await prisma.publishedDeal.findMany({
      orderBy: { publishedAt: "desc" },
      take: limit,
      include: { product: true },
    });
    return reply.send(deals);
  });

  // Nunca vazar stack trace para o usuário (seção 17).
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    // Erros 4xx (requisição malformada, payload vazio, etc.) são problemas
    // do lado do cliente - mostramos uma mensagem curta e sem stack trace,
    // mas preservamos o código, para não parecerem falhas do servidor.
    // Erros 5xx nunca vazam detalhes internos (seção 17).
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: error.message || "Requisição inválida" });
    }
    return reply.code(500).send({ error: "Erro interno do servidor" });
  });

  return app;
}
