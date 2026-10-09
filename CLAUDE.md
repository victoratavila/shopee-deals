# CLAUDE.md — Guia para trabalhar neste projeto

Este arquivo existe para qualquer pessoa (ou IA) que for continuar o
desenvolvimento deste sistema no futuro, para não quebrar as decisões já
tomadas.

## Regras invioláveis

1. **Nunca implementar WhatsApp/Telegram fora da Fase 7.** O núcleo não pode
   depender de `TelegramPublisher`/`WhatsAppPublisher` — essa camada ainda
   nem existe. Quando for criada, ela deve implementar uma interface
   `OfferPublisher` (a ser criada na Fase 7), assim como `ShopeeClient` já
   separa mock de real.
2. **Nunca presumir credenciais.** Se algo depende de uma credencial,
   conta ou aprovação externa que só o dono do projeto pode fornecer, pare
   e peça explicitamente — nunca invente um valor "de exemplo" que pareça
   real.
3. **Nunca deixar a falta de credenciais bloquear o desenvolvimento.**
   Sempre existe um mock/fixture equivalente (ver `MockShopeeClient`).
4. **Nunca inventar dados de produto** (preço, desconto, comissão,
   avaliação, vendas). Na dúvida, rejeitar a oferta é preferível a publicar
   algo errado (ver `evaluateOffer` e `checkSuspiciousPrice`).
5. **Nunca commitar `.env` ou secrets.** `.env.example` só tem placeholders.
6. **Nunca vazar stack trace ou dados sensíveis para o usuário/logs.** Ver
   `app.setErrorHandler` em `src/web/server.ts` e `ErrorLogRepository`.

## Arquitetura (visão geral)

O núcleo de negócio (`filters`, `dealscore`, `pricehistory`, `pipeline`,
`scheduler`) depende apenas de **interfaces** (`src/db/repositories.ts`,
`src/shopee/ShopeeClient.ts`), nunca de implementações concretas. Isso
permite:
- trocar `MockShopeeClient` por `RealShopeeClient` sem tocar no resto;
- testar o pipeline inteiro com repositórios fake em memória
  (`tests/inMemoryRepositories.ts`), sem precisar de Postgres rodando;
- adicionar canais de publicação (Telegram/WhatsApp) na Fase 7 sem
  reescrever busca, filtros, Deal Score, histórico ou banco.

Fluxo de uma execução (`runPipeline`):
```
ShopeeClient.searchOffers()
  -> para cada oferta:
     - duplicidade na rodada?
     - limite por rodada/dia atingido?
     - publicado recentemente? (minDaysBeforeRepublish)
     - preço suspeito? (comparado ao histórico real, não ao da Shopee)
     - passa nos filtros configuráveis? (evaluateOffer)
     -> se aceita: upsert do produto, histórico de preço, Deal Score,
        registro de "publicação" (canal TEST/DRY_RUN por enquanto)
     -> se rejeitada: motivo registrado em RejectedOffer
```

## Padrões de código

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  etc. ligados). Evite `any`; se for inevitável, comente o motivo.
- Módulos de regra de negócio (`filters`, `dealscore`, `pricehistory`,
  `scheduler`'s `decideTick`) são **funções puras**: recebem tudo já
  resolvido, não acessam banco/rede diretamente. Isso é o que os torna
  testáveis sem infraestrutura — mantenha esse padrão ao adicionar lógica
  nova.
- Repositórios são interfaces em `src/db/repositories.ts` + implementação
  Prisma em `src/db/prisma/`. Ao adicionar uma tabela nova, siga esse par.
- Configurações operacionais (filtros, limites, horários) ficam na tabela
  `Setting` (JSON), nunca hard-coded. Ver `src/config/operationalSettings.ts`.

## Testes

Rodar com `npm run test`. Toda regra de negócio nova deveria ganhar um
teste que não depende de banco (use os fakes em `tests/inMemoryRepositories.ts`
como modelo). Antes de considerar uma fase concluída, rodar:
```bash
npm run typecheck && npm run test && npm run build
```

## Segurança

- Senhas de admin: argon2 (`src/web/adminAuth.ts`), nunca texto plano.
- Sessão via cookie httpOnly + `ADMIN_SESSION_SECRET` (nunca reaproveitar
  entre ambientes).
- Rate limiting mais restrito em `/api/login` (5/min) do que no resto da
  API (100/min), para dificultar força bruta.
- Nenhuma rota `/api/*` (exceto `/api/login` e `/api/health`) responde sem
  sessão válida.

## Integração real com a Shopee (implementada)

`RealShopeeClient` já está implementado (GraphQL + assinatura SHA256 =
`hash("sha256", appId+timestamp+payload+secret)`, NÃO é HMAC apesar do nome
do header). Ativa automaticamente quando `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`
estão no `.env`. Duas limitações da API pública documentadas no código e no
README: sem `ratingCount` por produto, e "preço anterior" é estimado a
partir do desconto (não vem pronto da API).

## Fluxo de aprovação (importante para a Fase 7)

- **Aprovação automática** é o caminho normal: `runPipeline` aprova e
  registra em `PublishedDeal` qualquer oferta que passe nos filtros, sem
  intervenção humana. É esse registro que a Fase 7 vai usar como fila de
  "pronto para publicar" no WhatsApp/Telegram.
- **Aprovação manual** (`approveRejectedOfferManually`) é só uma exceção:
  reverte uma rejeição específica. Nunca é uma etapa obrigatória do fluxo
  normal, e propositalmente não reavalia filtros nem suspeita de preço -
  isso anularia o propósito de existir (o humano está sobrepondo a decisão
  automática de propósito).
- Regras que a aprovação manual RESPEITA mesmo assim: publicação recente
  (`minDaysBeforeRepublish`), limite diário (`maxOffersPerDay`), e
  duplicidade - tanto para a MESMA rejeição (clique duplo, via
  `claimManualApproval` atômico) quanto para DUAS rejeições DIFERENTES do
  MESMO PRODUTO (via `createIfNotRecentlyPublished`, transação
  Serializable no Postgres). Se a criação for recusada, a reivindicação é
  desfeita automaticamente (a oferta não fica "presa" como aprovada sem
  nada criado).
- **Concorrência**: `RunRepository.create()` é atômico (lock de linha
  única em `SchedulerLock`, ver `PrismaRunRepository`) - scheduler e
  execução manual nunca rodam pipelines ao mesmo tempo. Isso é o que
  garante que a mesma oferta nunca é aprovada/publicada duas vezes por
  essa via.

## O que falta (não implementar sem pedir confirmação antes)

- Execução real do deploy (guia pronto em `DEPLOY.md`: gratuito primeiro —
  Render + Supabase + cron-job.org —, com caminho de upgrade para pago
  documentado).
- Alertas externos (e-mail/webhook) quando algo crítico falha.
- WhatsApp/Telegram — somente na Fase 7, e somente depois de todas as fases
  anteriores validadas em produção.
