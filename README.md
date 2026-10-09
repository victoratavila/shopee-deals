# Shopee Deals — Sistema Automatizado de Ofertas

## Status: FASES 1, 2, 4 concluídas + base da FASE 3 (Painel) + FASE 5 documentada

Implementado nesta etapa:
- Estrutura do projeto (TypeScript strict, monorepo simples).
- Schema Prisma completo (Products, PriceHistory, PublishedDeals, Runs,
  RejectedOffer, Setting, ErrorLog, AdminUser).
- Configuração via `.env` validada com Zod.
- Configurações operacionais (filtros) com valores padrão, tipadas.
- Contrato `ShopeeClient` + `MockShopeeClient` (dados fictícios) +
  **`RealShopeeClient` implementado de verdade** (GraphQL + assinatura
  SHA256, ver seção abaixo) + factory que escolhe
  automaticamente qual usar.
- Motor de filtros (`evaluateOffer`) — função pura, testada.
- Deal Score modular com pesos configuráveis — testado.
- Detecção de preço suspeito baseada em histórico real — testada.
- **Retry com exponential backoff + timeout já plugados nas chamadas à
  Shopee dentro do pipeline** (busca e link de afiliado), com distinção
  entre erros retryable (rate limit, timeout) e não-retryable (credenciais
  inválidas).
- Repositórios (ports/interfaces) + implementações Prisma para todas as
  entidades.
- Pipeline completo (`runPipeline`) com duplicidade, limites, republicação
  prematura, preço suspeito, filtros, Deal Score e persistência.
- Scheduler automático (`node-cron`) com kill switch, janela de horário,
  intervalo mínimo entre rodadas e recuperação após reinício.
- Modos TEST / DRY_RUN / PRODUCTION.
- Painel administrativo (Fastify): login com sessão + argon2, rate
  limiting, Helmet, dashboard, configurações editáveis, execução manual,
  kill switch, histórico. UI mobile-first em `src/web/public/index.html`,
  `styles.css` e `app.js` (arquivos separados, sem inline - exigido pela
  Content Security Policy do Helmet).
- **Painel reformulado**: tela inicial simplificada (status, ações, ofertas
  com miniatura da imagem do produto) separada de uma segunda aba
  ("Execuções e configurações") com o histórico e os parâmetros. Cada
  filtro numérico tem um botão "Sem limite" (desativa aquele filtro sem
  precisar zerar/inflar o valor). Ofertas publicadas têm botão "Copiar
  link" (link de afiliado pronto) e, quando aprovadas manualmente, um
  botão "Desfazer" que reverte a aprovação e a oferta volta a aparecer
  como rejeitada pendente.
- **Filtro de período em "Ofertas rejeitadas"**: Hoje ou Últimos 3 dias
  (teto de 3 dias imposto no backend, não só escondido no frontend),
  agrupado visualmente por data.
- **Contador de buscas do dia** no dashboard (automáticas do scheduler vs.
  manuais via "Executar agora" vs. total) - reaproveita o histórico de
  execuções já existente, sem armazenamento novo.
- **Modal de detalhes**: clicar em qualquer oferta (rejeitada ou aprovada)
  abre um modal com todos os dados já armazenados - preço, desconto,
  avaliação, vendas, comissão, loja, Deal Score, motivo da rejeição, datas,
  links - útil para auditar por que o sistema decidiu aprovar ou rejeitar.
- **Tooltips** em cada campo de configuração, explicando o que controla,
  a unidade e o que "Sem limite" significa.
- Limites de busca e aprovação são independentes: as ofertas buscadas são
  processadas e registradas; ofertas válidas que excedem
  `maxOffersPerRound` são marcadas como `ROUND_LIMIT_REACHED`.
- O limite `maxOffersFetchedPerRound` pode ser aplicado à rodada inteira
  (`ROUND`) ou separadamente a cada categoria selecionada (`CATEGORY`).
  Quando uma categoria tem várias palavras-chave, o limite dela é dividido
  entre essas palavras-chave.
- **Limite diário agora trava a execução inteira**, não só rejeita ofertas
  uma a uma: ao atingir `maxOffersPerDay`, nenhuma nova execução roda -
  nem automática (scheduler) nem manual ("Executar agora") - até o limite
  ser aumentado ou o dia virar. A contagem é por canal (TEST/DRY_RUN não
  se misturam), pra dar pra testar essa trava sem afetar outro modo.
- **Ocultar e excluir ofertas rejeitadas**: botão para minimizar a lista
  sem perder os dados, e outro para apagar em massa todas as rejeições
  pendentes (preserva as já aprovadas manualmente, que o "Desfazer"
  precisa).
- **Totais por data** nas duas listas (rejeitadas e aprovadas), mostrados
  no cabeçalho de cada grupo de dia ("Hoje (4)", "Ontem (2)"...).
- **Estado da automação visível no dashboard** (ativa/pausada + janela de
  horário), pra facilitar diagnosticar por que o scheduler não está
  disparando sozinho.
- Recuperação automática de execuções travadas por crash.
- **Testes automatizados passando**, incluindo testes de resiliência
  (timeout, retry, rate limit, erro não-retryable, resposta inesperada da
  API, falha do banco em um produto específico, recuperação de run
  travado). Typecheck strict sem erros, build de produção validado.
- **Endpoint `/api/internal/scheduler-tick`** (protegido por `CRON_SECRET`,
  não por sessão de admin): permite que um cron **externo** gratuito
  (ex: cron-job.org) acorde a aplicação e dispare a verificação do
  scheduler em hospedagens gratuitas que dormem por inatividade (Render
  free tier). Em hospedagem paga/sempre ativa, isso é opcional — o
  `node-cron` interno já cobre tudo sozinho.
- **`DEPLOY.md`**: guia passo a passo de deploy, começando 100% gratuito
  (Render + Supabase + cron-job.org) com caminho de upgrade documentado
  para quando o projeto começar a gerar receita.

Ainda NÃO implementado (dependem de você ou de decisões futuras):
- Execução real do deploy (o guia está pronto, falta você criar as contas
  Railway/GitHub e seguir os passos, ou me pedir para te acompanhar nisso).
- Alertas externos (e-mail/webhook) quando algo crítico falha — arquitetura
  já permite adicionar sem reescrever nada (seção 20).
- WhatsApp/Telegram (somente na Fase 7, por definição do escopo).

## Primeiros passos para rodar localmente

```bash
npm install
cp .env.example .env   # edite DATABASE_URL e ADMIN_SESSION_SECRET
npm run prisma:migrate  # cria as tabelas no seu Postgres
npm run admin:create -- "seu-email@exemplo.com" "uma-senha-forte"
npm run test            # roda os testes do core (não precisa de banco)
npm run typecheck
npm run dev              # sobe o scheduler + painel em http://localhost:3000
```

Outros modos úteis:
```bash
npm run dev -- --once   # roda uma única rodada do pipeline e encerra (bom para depurar)
npm run dev -- --tick   # roda um único tick do scheduler (respeita horário/kill switch) e encerra
```

## Deploy em produção

Veja **[DEPLOY.md](./DEPLOY.md)** — guia passo a passo: começa em
**hospedagem 100% gratuita** (Render + Supabase + cron-job.org) e traz o
caminho de upgrade para hospedagem paga assim que o projeto gerar receita,
sem precisar reescrever nada.

## Nota sobre `npm run prisma:generate`

Este ambiente de desenvolvimento (sandbox) bloqueia o download dos binários
do Prisma Engine por política de rede. Isso **não afeta você**: no seu
computador ou no servidor de produção, `npx prisma generate` funciona
normalmente (é um download padrão do Prisma). Só rode esse comando depois
de configurar `DATABASE_URL` no `.env`.

## Rodando localmente

```bash
npm install
cp .env.example .env   # edite DATABASE_URL e ADMIN_SESSION_SECRET
npm run test           # roda os testes do core (não precisa de banco)
npm run typecheck
```

Para usar banco de verdade (necessário a partir da Fase 2):
```bash
npm run prisma:migrate
```

## Shopee Affiliate API

Enquanto `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET` não estiverem configurados no
`.env`, o sistema usa automaticamente o `MockShopeeClient` (dados fictícios),
mesmo fora do TEST mode. Isso é intencional: nada fica bloqueado por falta
de credenciais.

## Integração real com a Shopee (já implementada)

`src/shopee/RealShopeeClient.ts` implementa a Shopee Affiliate Open API de
verdade (GraphQL, assinatura SHA256). Basta preencher no `.env`:
```
SHOPEE_APP_ID="..."
SHOPEE_APP_SECRET="..."
SHOPEE_AFFILIATE_ID="..."   # opcional, ainda não usado diretamente
```
e reiniciar a aplicação — a factory troca automaticamente do
`MockShopeeClient` para o `RealShopeeClient`.

No modo **Categorias específicas**, cada palavra-chave das categorias
marcadas é enviada em uma busca separada à Shopee. Palavras repetidas
(ignorando espaços nas extremidades e diferenças entre maiúsculas/minúsculas)
são consultadas uma vez quando o limite é global. O limite de ofertas buscadas
pode ser aplicado à rodada inteira ou separadamente por categoria. No modo
por categoria, quando uma categoria tem várias palavras-chave, o limite é
dividido entre elas. O limite de ofertas aprovadas continua global e não impede
que as demais ofertas sejam avaliadas e registradas como rejeitadas.
As listas de ofertas aprovadas e rejeitadas identificam a palavra-chave que
encontrou cada item com uma etiqueta colorida estável por palavra-chave. Os
grupos servem apenas para organizar termos e ativá-los em conjunto.

**Duas limitações da API pública que valem calibrar no painel depois de
ativar:**
- Ela não expõe "quantidade de avaliações" (`ratingCount`) por produto —
  só a nota média. O filtro `minRatingCount` (padrão: 20) rejeitaria toda
  oferta real por falta desse dado. Assim que ativar, mude esse valor para
  `0` ou use "Sem limite" em Configurações no painel.
- Não existe um campo de "preço anterior" explícito — o sistema estima a
  partir do percentual de desconto informado (`priceMin / (1 - desconto)`),
  então a detecção de preço suspeito (seção 8) fica um pouco menos precisa
  no início, até haver histórico real acumulado.

Se sua conta de afiliado não for do Brasil, configure também
`SHOPEE_API_ENDPOINT` com o domínio correto (o padrão é
`open-api.affiliate.shopee.com.br`).

## Arquitetura (resumo)

```
src/
  config/     -> env + configurações operacionais (filtros)
  shopee/     -> contrato ShopeeClient + mock + stub real + factory
  filters/    -> motor de filtros (função pura)
  dealscore/  -> cálculo do Deal Score (função pura)
  pricehistory/ -> detecção de preço suspeito (função pura)
  pipeline/   -> orquestrador (busca -> filtros -> score -> persistência)
  scheduler/  -> decisão de quando rodar (cron, horário, kill switch)
  web/        -> painel administrativo (Fastify + auth + UI estática)
  db/
    repositories.ts -> interfaces (ports) usadas pelo pipeline/scheduler
    prisma/          -> implementações reais com Prisma
  utils/      -> retry/backoff/timeout
  types/      -> tipos de domínio compartilhados
prisma/
  schema.prisma -> modelo de dados completo
tests/        -> testes automatizados (Vitest), incluindo fakes em memória
```

O núcleo (filtros, deal score, histórico, pipeline, scheduler) depende só
de **interfaces**, nunca de Shopee real, Prisma ou HTTP diretamente. Isso
permite testar 100% da lógica de negócio — incluindo o fluxo completo de
uma execução e a decisão de quando rodar automaticamente — sem precisar de
banco de dados rodando.
