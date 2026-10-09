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
  revertManualApproval,
  rejectApprovedOfferManually,
  RejectedOfferNotFoundError,
  AlreadyApprovedError,
  MissingSnapshotError,
  RecentlyPublishedError,
  DailyLimitReachedError,
  PublishedDealNotFoundError,
  NotManuallyApprovedError,
  UseUndoInsteadError,
} from "../pipeline/approveRejectedOffer.js";
import {
  resolveEffectiveMode,
  schedulerTick,
  decideTick,
  getNextScheduledTickAt,
  getLatestSchedulerAnchor,
} from "../scheduler/scheduler.js";
import { isDailyLimitReached } from "../pipeline/dailyLimit.js";
import { startOfDaysAgo, clampPeriodDays } from "../utils/dateRange.js";
import { schedulerRunEvents, type SchedulerRunFinishedEvent } from "../scheduler/runEvents.js";

/** Forma esperada do JSON salvo em RejectedOffer.offerSnapshot - é o RawShopeeOffer serializado. */
interface RawShopeeOfferLike {
  name?: string;
  url?: string;
  imageUrl?: string;
  currentPrice?: number;
  previousPrice?: number;
  discountPercent?: number;
  rating?: number;
  ratingCount?: number;
  salesCount?: number;
  commissionPercent?: number;
  affiliateLink?: string;
  shopId?: string;
}

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

const SchedulerRefreshSchema = z.object({
  runId: z.string().min(1),
});

export async function buildWebServer(deps: WebServerDeps): Promise<FastifyInstance> {
  const { prisma, repos, shopeeClient, envRunMode, sessionSecret, appVersion, cronSecret } = deps;
  const app = Fastify({ logger: true, trustProxy: true });
  const authService = createAdminAuthService(prisma);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  });
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
  // (ex: Render free tier) e por isso não conseguem manter o scheduler interno
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

  app.get("/api/scheduler/events", async (_request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    const latestFinishedSchedulerRun = await prisma.run.findFirst({
      where: { triggeredBy: "scheduler", finishedAt: { not: null } },
      orderBy: { finishedAt: "desc" },
      select: { id: true, finishedAt: true },
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const onRunFinished = (event: SchedulerRunFinishedEvent) => {
      reply.raw.write(`event: run-finished\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => reply.raw.write(": keep-alive\n\n"), 30_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      schedulerRunEvents.off("run-finished", onRunFinished);
    };
    schedulerRunEvents.on("run-finished", onRunFinished);
    reply.raw.on("close", cleanup);
    reply.raw.write(": connected\n\n");
    if (
      latestFinishedSchedulerRun &&
      latestFinishedSchedulerRun.finishedAt !== null &&
      latestFinishedSchedulerRun.id !== settings.schedulerRefreshRunId
    ) {
      onRunFinished({
        runId: latestFinishedSchedulerRun.id,
        finishedAt: latestFinishedSchedulerRun.finishedAt.toISOString(),
      });
    }
  });

  app.get("/api/dashboard", async (_request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    const hasActiveRun = await repos.run.hasActiveRun();
    const lastFinishedAt = await repos.run.getLastFinishedAt();
    const schedulerIntervalAnchor = getLatestSchedulerAnchor(
      lastFinishedAt,
      settings.automationResumeAt,
      settings.schedulerRefreshAt,
    );
    const effectiveMode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
    const now = new Date();

    const recentRuns = await prisma.run.findMany({ orderBy: { startedAt: "desc" }, take: 5 });
    const latestFinishedSchedulerRun = await prisma.run.findFirst({
      where: { triggeredBy: "scheduler", finishedAt: { not: null } },
      orderBy: { finishedAt: "desc" },
      select: { id: true, finishedAt: true },
    });

    // Contador de buscas de hoje (seção 2) - reaproveita o histórico de Run
    // já existente, sem nenhum armazenamento novo.
    const searchesToday = await repos.run.countRunsSince(startOfDaysAgo(1));

    // Roda EXATAMENTE a mesma decisão que o cron interno roda a cada
    // segundo (decideTick), só que aqui é somente para exibição - não
    // dispara nada. É isso que permite ao painel mostrar o motivo real
    // pelo qual a automação não disparou sozinha, em vez do usuário ter
    // que adivinhar.
    const dailyLimitReached = await isDailyLimitReached(repos, settings, effectiveMode);
    const schedulerDecision = decideTick({
      now,
      automationEnabled: settings.automationEnabled,
      operatingHoursEnabled: settings.operatingHoursEnabled,
      automationStartTime: settings.automationStartTime,
      automationEndTime: settings.automationEndTime,
      automationTimeZone: settings.automationTimeZone,
      intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
      lastRunFinishedAt: schedulerIntervalAnchor,
      hasActiveRun,
      dailyLimitReached,
    });
    const nextRunAt = getNextScheduledTickAt({
      now,
      automationEnabled: settings.automationEnabled,
      operatingHoursEnabled: settings.operatingHoursEnabled,
      automationStartTime: settings.automationStartTime,
      automationEndTime: settings.automationEndTime,
      automationTimeZone: settings.automationTimeZone,
      intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
      lastRunFinishedAt: schedulerIntervalAnchor,
      hasActiveRun,
      dailyLimitReached,
    });

    return reply.send({
      version: appVersion,
      automationEnabled: settings.automationEnabled,
      dryRunEnabled: settings.dryRunEnabled,
      effectiveMode,
      hasActiveRun,
      lastFinishedAt,
      latestFinishedSchedulerRun,
      schedulerRefreshRunId: settings.schedulerRefreshRunId,
      operatingHours: {
        enabled: settings.operatingHoursEnabled,
        start: settings.automationStartTime,
        end: settings.automationEndTime,
        timeZone: settings.automationTimeZone,
      },
      intervalBetweenRoundsMinutes: settings.intervalBetweenRoundsMinutes,
      recentRuns,
      searchesToday,
      schedulerStatus: {
        willRunOnNextTick: schedulerDecision.shouldRun,
        reason: schedulerDecision.reason,
        nextRunAt,
      },
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

  app.post("/api/scheduler/refresh-complete", async (request, reply) => {
    const parsed = SchedulerRefreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Execução inválida" });
    }
    const run = await prisma.run.findUnique({
      where: { id: parsed.data.runId },
      select: { id: true, triggeredBy: true, finishedAt: true },
    });
    if (!run || run.triggeredBy !== "scheduler" || run.finishedAt === null) {
      return reply.code(404).send({ error: "Execução automática concluída não encontrada" });
    }

    const current = await repos.settings.getOperationalSettings();
    if (current.schedulerRefreshRunId === run.id) {
      return reply.send({ acknowledged: true, alreadyAcknowledged: true });
    }
    const settingsRepo = repos.settings as unknown as {
      saveOperationalSettings: (s: typeof current, updatedBy?: string) => Promise<void>;
    };
    await settingsRepo.saveOperationalSettings(
      {
        ...current,
        schedulerRefreshRunId: run.id,
        schedulerRefreshAt: new Date().toISOString(),
      },
      request.session.adminId,
    );
    return reply.send({ acknowledged: true, alreadyAcknowledged: false });
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
      if (err instanceof DailyLimitReachedError) {
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
      updated = { ...current, automationEnabled: false, automationResumeAt: null };
    } else if (parsed.data.action === "resume") {
      updated = {
        ...current,
        automationEnabled: true,
        automationResumeAt: new Date().toISOString(),
      };
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
  // aba "Ofertas rejeitadas" do painel (seção 14). Suporta filtro por
  // período: ?days=1 (hoje) | ?days=2 | ?days=3. O período máximo é sempre
  // MAX_REJECTIONS_PERIOD_DAYS (3), imposto aqui no backend - um pedido de
  // mais que isso é reduzido ao máximo, nunca atendido integralmente. O
  // filtro é aplicado no banco (não busca tudo e filtra no app) - ver
  // RejectedOfferRepository.listRecent.
  app.get("/api/rejections", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const limit = Math.min(Number(query["limit"] ?? 100), 300);

    const requestedDays = query["days"] !== undefined ? Number(query["days"]) : undefined;
    const days = clampPeriodDays(requestedDays);
    const since = startOfDaysAgo(days);

    const rejections = await repos.rejectedOffer.listRecent(limit, since);
    const totalPending = await repos.rejectedOffer.countPending(since);
    // Nunca devolve o offerSnapshot bruto pro front — só o que a UI precisa mostrar.
    const items = rejections
      // Já aprovadas não aparecem mais como "pendente" - elas passam a
      // aparecer em Ofertas publicadas, com a marca "manual".
      .filter((r) => r.manuallyApprovedAt === null)
      .map((r) => {
        let imageUrl: string | null = null;
        let currentPrice: number | null = null;
        let discountPercent: number | null = null;
        let searchCategoryId: string | null = null;
        let searchCategoryName: string | null = null;
        if (r.offerSnapshot) {
          try {
            const snapshot = JSON.parse(r.offerSnapshot) as {
              imageUrl?: string;
              currentPrice?: number;
              discountPercent?: number;
              searchCategoryId?: string;
              searchCategoryName?: string;
            };
            imageUrl = snapshot.imageUrl ?? null;
            currentPrice = snapshot.currentPrice ?? null;
            discountPercent = snapshot.discountPercent ?? null;
            searchCategoryId = snapshot.searchCategoryId ?? null;
            searchCategoryName = snapshot.searchCategoryName ?? null;
          } catch {
            // snapshot corrompido - segue sem esses dados extras, não é crítico
          }
        }
        return {
          id: r.id,
          shopeeItemId: r.shopeeItemId,
          productName: r.productName,
          imageUrl,
          currentPrice,
          discountPercent,
          searchCategoryId,
          searchCategoryName,
          reason: r.reason,
          details: r.details,
          canApprove: r.offerSnapshot !== null,
          createdAt: r.createdAt,
        };
      });

    return reply.send({ since: since ? since.toISOString() : null, total: totalPending, rejections: items });
  });

  // Apaga todas as rejeições pendentes (não as já aprovadas manualmente),
  // para o usuário limpar o banco quando quiser. Não tem filtro de período -
  // limpa tudo que está pendente, independente da janela de dias exibida.
  app.delete("/api/rejections", async (_request, reply) => {
    const deletedCount = await repos.rejectedOffer.deleteAllPending();
    return reply.send({ deletedCount });
  });

  // Apaga TODAS as ofertas (aprovadas + rejeitadas, incluindo as já
  // aprovadas manualmente), pra facilitar resetar o banco entre rodadas de
  // teste. A checagem de modo é feita AQUI, no backend - esconder o botão
  // no painel não seria suficiente, porque alguém ainda poderia chamar essa
  // rota diretamente. Nunca funciona em PRODUCTION, mesmo que alguém tente.
  app.post("/api/testing/wipe-offers", async (_request, reply) => {
    const settings = await repos.settings.getOperationalSettings();
    const effectiveMode = resolveEffectiveMode(envRunMode, settings.dryRunEnabled);
    if (effectiveMode === "PRODUCTION") {
      return reply.code(403).send({
        error: "Essa ação só é permitida nos modos Teste ou Ensaio, nunca em Produção.",
      });
    }
    const deletedDeals = await repos.publishedDeal.deleteAll();
    const deletedRejections = await repos.rejectedOffer.deleteAll();
    return reply.send({ deletedDeals, deletedRejections });
  });

  // Detalhe completo de uma rejeição específica - alimenta o modal de
  // auditoria (seção 3). Expõe tudo que já está armazenado no snapshot,
  // sem inventar campos que o sistema não tem.
  app.get("/api/rejections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const rejected = await repos.rejectedOffer.findById(id);
    if (!rejected) return reply.code(404).send({ error: "Oferta rejeitada não encontrada." });

    let snapshot: RawShopeeOfferLike = {};
    if (rejected.offerSnapshot) {
      try {
        snapshot = JSON.parse(rejected.offerSnapshot) as RawShopeeOfferLike;
      } catch {
        // snapshot corrompido - segue só com os campos que vieram do banco
      }
    }

    return reply.send({
      id: rejected.id,
      shopeeItemId: rejected.shopeeItemId,
      productName: rejected.productName ?? snapshot.name ?? null,
      productUrl: snapshot.url ?? null,
      imageUrl: snapshot.imageUrl ?? null,
      currentPrice: snapshot.currentPrice ?? null,
      previousPrice: snapshot.previousPrice ?? null,
      discountPercent: snapshot.discountPercent ?? null,
      rating: snapshot.rating ?? null,
      ratingCount: snapshot.ratingCount ?? null,
      salesCount: snapshot.salesCount ?? null,
      commissionPercent: snapshot.commissionPercent ?? null,
      affiliateLink: snapshot.affiliateLink ?? null,
      shopId: snapshot.shopId ?? null,
      reason: rejected.reason,
      details: rejected.details,
      createdAt: rejected.createdAt,
      manuallyApprovedAt: rejected.manuallyApprovedAt,
      manuallyApprovedBy: rejected.manuallyApprovedBy,
      canApprove: rejected.offerSnapshot !== null && rejected.manuallyApprovedAt === null,
    });
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
      if (err instanceof RecentlyPublishedError) return reply.code(409).send({ error: err.message });
      if (err instanceof DailyLimitReachedError) return reply.code(409).send({ error: err.message });
      if (err instanceof MissingSnapshotError) return reply.code(422).send({ error: err.message });
      request.log.error(err);
      return reply.code(500).send({ error: "Falha ao aprovar a oferta manualmente" });
    }
  });

  app.get("/api/deals", async (request, reply) => {
    const limit = Math.min(Number((request.query as Record<string, string>)["limit"] ?? 20), 100);
    const deals = await repos.publishedDeal.listRecent(limit);
    // Total de verdade, sem o teto do "limit" da consulta - sem isso, o
    // contador do painel travava no valor de "limit" (ex: sempre "100")
    // quando havia mais publicações que isso, mesmo depois de desfazer uma.
    const total = await repos.publishedDeal.countPublishedSince(new Date(0));
    return reply.send({ total, deals });
  });

  // Detalhe completo de uma oferta publicada - alimenta o modal de
  // auditoria (seção 3). Todos os campos já vêm do Product + PublishedDeal
  // existentes (ver PublishedDealRepository.findById).
  app.get("/api/deals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deal = await repos.publishedDeal.findById(id);
    if (!deal) return reply.code(404).send({ error: "Oferta publicada não encontrada." });
    return reply.send(deal);
  });

  // Desfaz uma aprovação manual feita por engano - volta a oferta pra lista
  // de rejeitadas pendentes, como se a aprovação nunca tivesse acontecido.
  app.post("/api/deals/:id/revert", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await revertManualApproval(repos, id);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof PublishedDealNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof NotManuallyApprovedError) return reply.code(422).send({ error: err.message });
      request.log.error(err);
      return reply.code(500).send({ error: "Falha ao desfazer a aprovação" });
    }
  });

  // Rejeita manualmente uma oferta que tinha sido aprovada AUTOMATICAMENTE -
  // o inverso de "Aprovar manualmente". Ofertas aprovadas manualmente usam
  // /revert (acima), que restaura a rejeição original em vez de criar uma nova.
  app.post("/api/deals/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await rejectApprovedOfferManually(repos, id, request.session.adminId!);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof PublishedDealNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof UseUndoInsteadError) return reply.code(422).send({ error: err.message });
      request.log.error(err);
      return reply.code(500).send({ error: "Falha ao rejeitar a oferta" });
    }
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
