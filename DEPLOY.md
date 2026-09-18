# Guia de Deploy — passo a passo

Este guia assume que você **nunca fez deploy antes**. Ele tem duas etapas:

1. **Fase inicial (gratuita):** Render (aplicação) + Supabase (banco Postgres)
   + cron-job.org (para manter tudo funcionando mesmo em plano free).
2. **Fase paga (quando gerar receita):** upgrade simples, sem reescrever nada.

---

## Por que essa combinação para começar de graça

Hospedagens gratuitas de verdade sempre têm uma pegadinha. Nesta combinação,
a pegadinha é: **a aplicação "dorme" depois de 15 minutos sem receber
requisições**, e o banco "pausa" depois de 7 dias sem atividade. Isso
quebraria um scheduler automático comum — por isso o sistema já tem um
endpoint especial (`/api/internal/scheduler-tick`) que um serviço de cron
**externo e gratuito** chama a cada poucos minutos: isso acorda a aplicação
e verifica se é hora de rodar uma nova busca de ofertas, ao mesmo tempo que
mantém o banco "ativo" (evitando a pausa por inatividade).

**Limitações que você deve saber, para não ser pego de surpresa:**
- A primeira requisição depois de um período ocioso pode demorar de 30 a 60
  segundos (a aplicação está "acordando"). Isso não afeta a coleta de
  ofertas, só o carregamento do painel se você acessar bem depois de uma
  pausa.
- O banco gratuito (Supabase) tem limite de 500 MB — mais que suficiente
  para começar, mas vale ficar de olho conforme o histórico de preços
  cresce.
- Nenhuma das duas plataformas garante backup automático no plano
  gratuito — veja a seção de Backup abaixo, é simples de contornar.

Se algum desses pontos for inaceitável desde já, me avise que ajustamos
para começar direto na Fase Paga.

---

## FASE INICIAL — Hospedagem gratuita

### Passo 1 — Colocar o código no GitHub

1. Crie uma conta em **github.com** (se ainda não tiver).
2. Crie um repositório novo, **privado**.
3. No seu computador, dentro da pasta do projeto:
   ```bash
   git init
   git add .
   git commit -m "Core do sistema"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/NOME_DO_REPO.git
   git push -u origin main
   ```
   Confirme que o `.gitignore` (já incluído no projeto) está sendo
   respeitado — `.env` e `node_modules` nunca devem ir para o GitHub.

### Passo 2 — Criar o banco no Supabase (gratuito)

1. Acesse **supabase.com** e crie uma conta.
2. Clique em **"New Project"**. Escolha uma senha forte para o banco
   (guarde-a — você vai precisar dela na `DATABASE_URL`).
3. Espere o projeto ser provisionado (leva 1-2 minutos).
4. Vá em **Project Settings → Database → Connection string** e copie a
   string no formato **"URI"** (modo **Session**, porta `5432`). Vai ser
   algo como:
   ```
   postgresql://postgres:[SUA-SENHA]@db.xxxxxxxx.supabase.co:5432/postgres
   ```
   Esse é o valor que vai na variável `DATABASE_URL`.

### Passo 3 — Criar o serviço no Render (gratuito)

1. Acesse **render.com** e crie uma conta (dá para entrar com GitHub).
2. Clique em **"New +"** → **"Web Service"**.
3. Selecione o repositório do Passo 1. Autorize o acesso se pedido.
4. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build && npx prisma generate`
   - **Start Command:** `npx prisma migrate deploy && npm start`
   - **Instance Type:** Free
5. Em **"Environment"**, adicione as variáveis:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a string copiada do Supabase no Passo 2 |
   | `RUN_MODE` | `DRY_RUN` |
   | `ADMIN_SESSION_SECRET` | gere com `openssl rand -hex 32` no seu computador |
   | `CRON_SECRET` | gere com `openssl rand -hex 32` (valor diferente do anterior) |
   | `NODE_ENV` | `production` |
   | `SHOPEE_APP_ID` / `SHOPEE_APP_SECRET` / `SHOPEE_AFFILIATE_ID` | deixe em branco por enquanto |

6. Clique em **"Create Web Service"**. O Render builda e sobe a aplicação —
   acompanhe pela aba **"Logs"**. Ao final, você tem uma URL do tipo
   `https://seu-app.onrender.com`, **já com HTTPS automático**.

### Passo 4 — Criar o primeiro usuário administrador

No painel do Render, aba **"Shell"** do seu serviço:
```bash
npm run admin:create -- "seu-email@exemplo.com" "uma-senha-forte"
```

### Passo 5 — Configurar o cron externo gratuito (cron-job.org)

Isso substitui o cron interno enquanto a aplicação estiver no plano
gratuito do Render (que dorme quando ociosa).

1. Acesse **cron-job.org** e crie uma conta gratuita.
2. Crie um novo cronjob:
   - **URL:** `https://seu-app.onrender.com/api/internal/scheduler-tick`
   - **Método:** POST
   - **Cabeçalho (header) customizado:** `X-Cron-Secret: <o mesmo valor que você colocou em CRON_SECRET no Render>`
   - **Intervalo:** a cada 10 minutos (suficiente para não deixar a
     aplicação dormir e ainda respeitar o `intervalBetweenRoundsMinutes`
     configurado no painel).
3. Salve e rode um teste manual pelo próprio cron-job.org para confirmar
   que retorna `200 OK`.

### Passo 6 — Verificar se está tudo funcionando

1. `https://seu-app.onrender.com/api/health` → deve responder
   `{"status":"ok","database":true,...}` (pode demorar ~40s na primeira
   vez, se a aplicação estava dormindo).
2. Acesse `https://seu-app.onrender.com/` e faça login.
3. Clique em **"Executar agora"** — com `RUN_MODE=DRY_RUN`, nada é
   publicado de verdade, mas você vê o resultado da rodada.
4. Espere ~10-15 minutos e confira em **cron-job.org → histórico de
   execuções** se as chamadas automáticas estão retornando sucesso.

### Backup no plano gratuito

Nem Render nem Supabase garantem backup automático no free tier. Faça
backups manuais periódicos do seu computador:
```bash
pg_dump "SUA_DATABASE_URL_DO_SUPABASE" > backup-$(date +%Y%m%d).sql
```
Para restaurar: `psql "SUA_DATABASE_URL" < backup-20260101.sql`

### Logs

Aba **"Logs"** do serviço no Render, em tempo real.

### Atualizar / Rollback

```bash
git add . && git commit -m "descrição" && git push
```
O Render faz deploy automático a cada push. Para rollback, aba
**"Events"** do serviço no Render tem a lista de deploys anteriores com
opção de reverter.

---

## FASE PAGA — quando começar a gerar receita

Quando o volume justificar (ou os limites do free tier começarem a
incomodar — cold start, banco pausando, 500 MB), o upgrade é simples e
**não exige mudar nenhuma linha de código**, só configuração:

### Opção A — mais simples: só pagar pelo Render

1. No painel do Render, mude o **Instance Type** do serviço de "Free" para
   **"Starter"** (a partir de US$7/mês) — isso remove o "dormir por
   inatividade".
2. Nesse ponto, o cron externo (cron-job.org) já não é mais necessário
   para manter a aplicação acordada — mas não tem problema em deixá-lo
   rodando, ele só vai confirmar que está tudo bem. Se preferir, delete o
   cronjob e o sistema volta a usar o `node-cron` interno automaticamente
   (ele já está rodando o tempo todo, só nunca conseguia disparar com a
   aplicação dormindo).
3. Se o banco do Supabase (500 MB) também estiver no limite, faça upgrade
   dele separadamente para o **Supabase Pro** (US$25/mês) — sem precisar
   trocar a `DATABASE_URL` nem migrar dados.

### Opção B — consolidar tudo em uma plataforma só (Railway)

Se preferir simplificar para uma única fatura (aplicação + banco no mesmo
lugar), migre para a Railway:
1. Crie um projeto na Railway com um banco Postgres gerenciado.
2. Migre os dados do Supabase para o Postgres da Railway:
   ```bash
   pg_dump "DATABASE_URL_SUPABASE" > dump.sql
   psql "DATABASE_URL_RAILWAY" < dump.sql
   ```
3. Aponte o serviço da aplicação (pode continuar no Render pago, ou também
   migrar para a Railway) para a nova `DATABASE_URL`.
4. Desative o cronjob externo — não é mais necessário em um serviço
   sempre ativo (a Railway não dorme por inatividade nos planos pagos).

Recomendo a **Opção A** primeiro: é a mudança mais simples (dois cliques,
zero migração de dados) e resolve o problema mais comum (cold start).

---

## Quando a integração real da Shopee estiver pronta

1. Preencha `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET` e `SHOPEE_AFFILIATE_ID`
   nas variáveis de ambiente da plataforma que você estiver usando.
2. A aplicação reinicia automaticamente ao salvar.
3. A partir daí, o `createShopeeClient` passa a usar o `RealShopeeClient`
   de verdade em vez do mock, assim que implementarmos essa classe (é o
   próximo passo assim que você me passar as credenciais).
