async function api(path, opts) {
  const hasBody = opts && opts.body !== undefined;
  const headers = hasBody ? { "Content-Type": "application/json" } : {};
  const res = await fetch(path, { headers, ...opts });
  if (res.status === 401) {
    showLogin();
    throw new Error("not authenticated");
  }
  if (!res.ok)
    throw new Error(
      (await res.json().catch(() => ({}))).error || res.statusText,
    );
  return res.json();
}

// --- Feedback unificado (toast) ---
// Antes, cada ação escrevia numa div de texto fixa no topo da página -
// se a ação acontecia lá embaixo na lista (aprovar, desfazer...), a
// confirmação ficava fora da área visível. Um toast aparece perto de onde
// o usuário está olhando, sempre no mesmo lugar, para qualquer ação.
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

// Nomes técnicos (TEST/DRY_RUN/PRODUCTION/TELEGRAM/WHATSAPP) traduzidos pra
// algo que explica o que cada modo realmente faz, sem precisar saber a
// terminologia interna do sistema.
const MODE_INFO = {
  TEST: {
    label: "Teste (fictício)",
    hint: "Usa produtos de exemplo inventados, sem se conectar à Shopee de verdade. Nada é gasto, nada é publicado - serve só para experimentar o sistema.",
  },
  DRY_RUN: {
    label: "Ensaio (dados reais)",
    hint: "Busca produtos reais na Shopee e decide quais aprovaria de verdade, mas NÃO publica nada em lugar nenhum. É um teste seguro, com dados reais, sem risco.",
  },
  PRODUCTION: {
    label: "Produção",
    hint: "Modo real. Quando o WhatsApp/Telegram forem conectados no futuro, é neste modo que as ofertas aprovadas seriam realmente enviadas.",
  },
  TELEGRAM: { label: "Telegram", hint: "Publicado de verdade no Telegram." },
  WHATSAPP: { label: "WhatsApp", hint: "Publicado de verdade no WhatsApp." },
};

function modeLabel(mode) {
  return MODE_INFO[mode]?.label ?? mode;
}
function modeHint(mode) {
  return MODE_INFO[mode]?.hint ?? "";
}

function showLogin() {
  document.getElementById("login-screen").style.display = "block";
  document.getElementById("app").style.display = "none";
}
function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "block";
  refreshAll();
}

async function login() {
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  const msg = document.getElementById("login-msg");
  msg.textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    showApp();
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}

function switchView(view) {
  document.getElementById("view-home").hidden = view !== "home";
  document.getElementById("view-runs").hidden = view !== "runs";
  for (const btn of document.querySelectorAll(".tab-btn")) {
    const active = btn.dataset.view === view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
}

// Alterna qual das duas listas de ofertas aparece (nunca as duas ao mesmo
// tempo) - reduz pela metade o que precisa ser lido/rolado de uma vez.
function switchOffersTab(tab) {
  document.getElementById("offers-rejected").hidden = tab !== "rejected";
  document.getElementById("offers-deals").hidden = tab !== "deals";
  for (const btn of document.querySelectorAll("[data-offers-tab]")) {
    const active = btn.dataset.offersTab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
}

async function refreshAll() {
  await loadSettings();
  await Promise.all([
    loadDashboard(),
    loadRuns(),
    loadRejected(),
    loadDeals(),
  ]);
}

// Guarda o estado atual da automação pra saber que ação o botão único deve
// disparar (pausar ou retomar) - nunca mostramos os dois ao mesmo tempo.
let currentAutomationEnabled = false;

async function loadDashboard() {
  const d = await api("/api/dashboard");
  document.getElementById("stat-mode").textContent = modeLabel(d.effectiveMode);
  document
    .getElementById("stat-mode-info")
    .setAttribute("data-tooltip", modeHint(d.effectiveMode));

  const dot = document.getElementById("stat-active-dot");
  dot.className = "dot " + (d.hasActiveRun ? "on" : "off");
  document.getElementById("stat-active-text").textContent = d.hasActiveRun
    ? "Rodando agora"
    : "Parado";

  currentAutomationEnabled = d.automationEnabled;
  const toggleBtn = document.getElementById("btn-toggle-automation");
  toggleBtn.textContent = d.automationEnabled
    ? "Pausar automação"
    : "Retomar automação";
  toggleBtn.className = d.automationEnabled
    ? "btn-secondary"
    : "btn-primary-outline";

  // Nunca mostra esse botão em Produção - o backend também recusa a ação
  // nesse modo, isso aqui é só pra nem oferecer a opção.
  document.getElementById("btn-wipe-offers").hidden =
    d.effectiveMode === "PRODUCTION";

  document.getElementById("stat-hours").textContent =
    `${d.operatingHours.start}h às ${d.operatingHours.end}h`;

  const sched = d.schedulerStatus;
  const schedEl = document.getElementById("stat-scheduler-status");
  if (!sched) {
    schedEl.textContent = "—";
  } else if (sched.willRunOnNextTick) {
    schedEl.textContent = "no próximo minuto \u2713";
  } else {
    const eta = sched.nextEligibleAt
      ? ` (\u00e0s ${new Date(sched.nextEligibleAt).toLocaleTimeString("pt-BR")})`
      : "";
    schedEl.textContent = `bloqueada: ${sched.reason}${eta}`;
  }

  document.getElementById("stat-last").textContent = d.lastFinishedAt
    ? new Date(d.lastFinishedAt).toLocaleString("pt-BR")
    : "nunca";
  const s = d.searchesToday;
  document.getElementById("stat-searches-today").textContent = s
    ? `${s.schedulerCount} automática${s.schedulerCount === 1 ? "" : "s"} \u00b7 ${s.manualCount} ${s.manualCount === 1 ? "manual" : "manuais"} \u00b7 ${s.totalCount} no total`
    : "—";
}

async function loadRuns() {
  const tbody = document.querySelector("#runs-table tbody");
  const runs = await api("/api/runs?limit=15");
  tbody.innerHTML = "";
  if (runs.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="empty-hint">Nenhuma execução ainda.</td></tr>';
    return;
  }
  for (const r of runs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${new Date(r.startedAt).toLocaleString("pt-BR")}</td><td>${modeLabel(r.mode)}</td><td>${r.status}</td><td>${r.dealsSelected}</td><td>${r.errorsCount}</td>`;
    tbody.appendChild(tr);
  }
}

function thumbHtml(imageUrl) {
  if (imageUrl) {
    return `<img class="offer-thumb" src="${imageUrl}" alt="" loading="lazy" />`;
  }
  return `<div class="offer-thumb-placeholder">\u{1F4E6}</div>`;
}

/** Troca imagens quebradas por um placeholder - via JS, não via atributo onerror inline (bloqueado pela CSP). */
function attachThumbFallbacks(container) {
  for (const img of container.querySelectorAll("img.offer-thumb")) {
    img.addEventListener("error", () => {
      const placeholder = document.createElement("div");
      placeholder.className = "offer-thumb-placeholder";
      placeholder.textContent = "\u{1F4E6}";
      img.replaceWith(placeholder);
    });
  }
}

function showListLoading(container) {
  container.innerHTML = '<p class="empty-hint">Carregando…</p>';
}

function money(value) {
  return value != null ? `R$ ${Number(value).toFixed(2)}` : "";
}

function categoryHue(categoryId) {
  const configuredHue = configuredCategoryHues.get(categoryId);
  if (configuredHue !== undefined) return configuredHue;
  let hash = 2166136261;
  for (const char of categoryId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

let configuredCategoryHues = new Map();

function categoryBadgeHtml(categoryId, categoryName) {
  if (!categoryId || !categoryName) {
    return '<span class="offer-category-badge offer-category-unknown">Categoria não registrada</span>';
  }
  return `<span class="offer-category-badge" style="--category-hue:${categoryHue(categoryId)}">${escapeHTML(categoryName)}</span>`;
}

function refreshConfiguredCategoryHues() {
  const keywords = [
    ...new Set(
      localCategories.flatMap((category) =>
        category.keywords
          .map((keyword) => keyword.trim().toLowerCase())
          .filter(Boolean),
      ),
    ),
  ];
  configuredCategoryHues = new Map(
    keywords.map((keyword, index) => [
      `keyword:${keyword}`,
      Math.round((index * 360) / Math.max(keywords.length, 1)),
    ]),
  );
}

function getSelectedRejectedPeriodDays() {
  const select = document.getElementById("rejected-period");
  return Number(select.value); // só "1" (hoje) ou "3" (últimos 3 dias) - ver <select> no HTML
}

function formatDateBR(date) {
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "Hoje", "Ontem" ou a data por extenso - comparando só a parte de calendário, no fuso local. */
function dateGroupLabel(date) {
  const startOfDay = (d) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };
  const today = startOfDay(new Date());
  const diffDays = Math.round((today - startOfDay(date)) / 86400000);
  if (diffDays === 0) return "Hoje";
  if (diffDays === 1) return "Ontem";
  return formatDateBR(date);
}

/** Agrupa itens por dia de calendário (usando `getDate(item)` pra achar a data),
 *  preservando a ordem em que já vieram (mais recentes primeiro). */
function groupByDate(items, getDate) {
  const groups = new Map();
  for (const item of items) {
    const label = dateGroupLabel(new Date(getDate(item)));
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  return groups;
}

function renderDateGroupHeading(container, label, count) {
  const heading = document.createElement("div");
  heading.className = "date-group-heading";
  heading.textContent = `${label} (${count})`;
  container.appendChild(heading);
}

async function loadRejected() {
  const days = getSelectedRejectedPeriodDays();
  const params = new URLSearchParams({ limit: "100", days: String(days) });
  const container = document.getElementById("rejected-list");
  showListLoading(container);

  const {
    since,
    total,
    rejections: rows,
  } = await api(`/api/rejections?${params.toString()}`);

  document.getElementById("count-rejected").textContent =
    total > 0 ? total : "";

  const label = document.getElementById("rejected-period-label");
  label.textContent = since
    ? `Mostrando de ${formatDateBR(new Date(since))} até hoje (${rows.length} oferta${rows.length === 1 ? "" : "s"})`
    : `Mostrando tudo (${rows.length} oferta${rows.length === 1 ? "" : "s"})`;

  container.innerHTML = "";
  if (rows.length === 0) {
    container.innerHTML =
      '<p class="empty-hint">Nenhuma rejeição neste período. \u2728</p>';
    return;
  }

  const groups = groupByDate(rows, (r) => r.createdAt);
  for (const [groupLabel, groupRows] of groups) {
    renderDateGroupHeading(container, groupLabel, groupRows.length);
    for (const r of groupRows) {
      const div = document.createElement("div");
      div.className = "offer-card";
      div.dataset.detailKind = "rejected";
      div.dataset.detailId = r.id;
      const meta = [
        money(r.currentPrice),
        r.discountPercent ? `-${r.discountPercent}%` : null,
        r.reason,
      ]
        .filter(Boolean)
        .join(" \u00b7 ");
      const approveButton = r.canApprove
        ? `<button class="btn-small btn-approve" data-approve="${r.id}">Aprovar</button>`
        : "";
      div.innerHTML = `
        ${thumbHtml(r.imageUrl)}
        <div class="offer-info">
          <div class="offer-heading">
            <div class="offer-name">${escapeHTML(r.productName || r.shopeeItemId)}</div>
            ${categoryBadgeHtml(r.searchCategoryId, r.searchCategoryName)}
          </div>
          <div class="offer-meta">${meta}</div>
        </div>
        <div class="offer-actions">${approveButton}</div>
      `;
      container.appendChild(div);
    }
  }
  attachThumbFallbacks(container);
}

function toggleRejectedVisibility() {
  const container = document.getElementById("rejected-list");
  const label = document.getElementById("rejected-period-label");
  const btn = document.getElementById("btn-toggle-rejected");
  const nowHidden = !container.hidden;
  container.hidden = nowHidden;
  label.hidden = nowHidden;
  btn.textContent = nowHidden ? "Mostrar" : "Ocultar";
  btn.setAttribute("aria-expanded", String(!nowHidden));
}

async function deleteAllRejected() {
  if (
    !confirm(
      "Excluir todas as ofertas rejeitadas pendentes? As já aprovadas manualmente não são afetadas.",
    )
  ) {
    return;
  }
  try {
    const result = await api("/api/rejections", { method: "DELETE" });
    showToast(`${result.deletedCount} rejeição(ões) excluída(s).`, "success");
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function approveOffer(id) {
  try {
    await api(`/api/rejections/${id}/approve`, { method: "POST" });
    showToast("Oferta aprovada.", "success");
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function loadDeals() {
  const container = document.getElementById("deals-list");
  showListLoading(container);

  const { total, deals: rows } = await api("/api/deals?limit=100");
  document.getElementById("count-deals").textContent = total > 0 ? total : "";

  container.innerHTML = "";
  if (rows.length === 0) {
    container.innerHTML =
      '<p class="empty-hint">Nenhuma oferta publicada ainda.</p>';
    return;
  }

  const groups = groupByDate(rows, (d) => d.publishedAt);
  for (const [groupLabel, groupRows] of groups) {
    renderDateGroupHeading(container, groupLabel, groupRows.length);
    for (const d of groupRows) {
      const div = document.createElement("div");
      div.className = "offer-card";
      div.dataset.detailKind = "deal";
      div.dataset.detailId = d.id;
      const meta = [
        money(d.priceAtPublish),
        `score ${Number(d.dealScore).toFixed(0)}`,
        d.approvedManually ? "manual" : null,
      ]
        .filter(Boolean)
        .join(" \u00b7 ");
      const copyButton = d.affiliateLink
        ? `<button class="btn-small btn-link" data-copy-link="${d.affiliateLink}">Copiar link</button>`
        : "";
      // Aprovada manualmente -> "Desfazer" (restaura a rejeição original).
      // Aprovada automaticamente -> "Rejeitar" (cria uma rejeição nova).
      const secondaryButton = d.approvedManually
        ? `<button class="btn-small btn-revert" data-revert="${d.id}">Desfazer</button>`
        : `<button class="btn-small btn-danger" data-reject="${d.id}">Rejeitar</button>`;
      div.innerHTML = `
        ${thumbHtml(d.productImageUrl)}
        <div class="offer-info">
          <div class="offer-heading">
            <div class="offer-name">${escapeHTML(d.productName)}</div>
            ${categoryBadgeHtml(d.searchCategoryId, d.searchCategoryName)}
          </div>
          <div class="offer-meta">${meta}</div>
        </div>
        <div class="offer-actions">${copyButton}${secondaryButton}</div>
      `;
      container.appendChild(div);
    }
  }
  attachThumbFallbacks(container);
}

async function copyAffiliateLink(link, triggerEl) {
  try {
    await navigator.clipboard.writeText(link);
    const original = triggerEl.textContent;
    triggerEl.textContent = "Copiado!";
    showToast("Link copiado.", "success");
    setTimeout(() => {
      triggerEl.textContent = original;
    }, 1500);
  } catch {
    showToast(
      "Não foi possível copiar automaticamente. Link: " + link,
      "error",
    );
  }
}

async function revertDeal(id) {
  try {
    await api(`/api/deals/${id}/revert`, { method: "POST" });
    showToast(
      "Aprovação desfeita - a oferta voltou para rejeitadas.",
      "success",
    );
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function rejectDeal(id) {
  if (
    !confirm(
      'Rejeitar esta oferta? Ela sai de "Aprovadas" e passa a aparecer em "Rejeitadas" (dá pra aprovar de novo depois, se mudar de ideia).',
    )
  ) {
    return;
  }
  try {
    await api(`/api/deals/${id}/reject`, { method: "POST" });
    showToast("Oferta rejeitada.", "success");
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  }
}

// --- Modal de detalhes (auditoria de por que uma oferta foi aprovada/rejeitada) ---

function modalRow(label, value) {
  if (value === null || value === undefined || value === "") return "";
  return `<div class="modal-row"><span class="k">${label}</span><span class="v">${value}</span></div>`;
}

function modalLinkRow(label, url) {
  if (!url) return "";
  return `<div class="modal-row"><span class="k">${label}</span><span class="v"><a href="${url}" target="_blank" rel="noopener noreferrer">Abrir</a></span></div>`;
}

function formatDateTimeBR(value) {
  return value ? new Date(value).toLocaleString("pt-BR") : null;
}

async function openDetailModal(kind, id) {
  const overlay = document.getElementById("detail-modal");
  const content = document.getElementById("modal-content");
  content.innerHTML = '<p class="empty-hint">Carregando…</p>';
  overlay.hidden = false;

  try {
    const data =
      kind === "rejected"
        ? await api(`/api/rejections/${id}`)
        : await api(`/api/deals/${id}`);

    const title = data.productName || data.shopeeItemId || "Produto";
    const thumb = data.imageUrl || data.productImageUrl;

    let html = "";
    html += thumb ? `<img class="modal-thumb" src="${thumb}" alt="" />` : "";
    html += `<h3 class="modal-title">${title}</h3>`;

    html += '<div class="modal-section-title">Preço e desconto</div>';
    html += modalRow("Preço atual", money(data.currentPrice));
    html += modalRow("Preço anterior", money(data.previousPrice));
    html += modalRow(
      "Desconto",
      data.discountPercent != null ? `${data.discountPercent}%` : null,
    );

    html += '<div class="modal-section-title">Popularidade e comissão</div>';
    html += modalRow(
      "Avaliação",
      data.rating != null ? `${data.rating} / 5` : null,
    );
    html += modalRow("Qtd. avaliações", data.ratingCount);
    html += modalRow("Vendas", data.salesCount);
    html += modalRow(
      "Comissão",
      data.commissionPercent != null ? `${data.commissionPercent}%` : null,
    );
    html += modalRow("Loja (ID)", data.shopId);

    if (kind === "deal") {
      html += '<div class="modal-section-title">Aprovação</div>';
      html += modalRow("Deal Score", Number(data.dealScore).toFixed(1));
      html += modalRow("Canal", modeLabel(data.channel));
      html += modalRow("Publicado em", formatDateTimeBR(data.publishedAt));
      html += modalRow(
        "Aprovado manualmente",
        data.approvedManually ? "Sim" : "Não (automático)",
      );
      html += modalRow("Aprovado por", data.approvedBy);
    } else {
      html += '<div class="modal-section-title">Rejeição</div>';
      html += modalRow("Motivo", data.reason);
      html += modalRow("Detalhes", data.details);
      html += modalRow("Rejeitado em", formatDateTimeBR(data.createdAt));
      html += modalRow(
        "Aprovado manualmente em",
        formatDateTimeBR(data.manuallyApprovedAt),
      );
      html += modalRow("Aprovado por", data.manuallyApprovedBy);
    }

    html += '<div class="modal-section-title">Links</div>';
    html += modalLinkRow("Página do produto", data.productUrl || data.url);
    html += modalLinkRow("Link de afiliado", data.affiliateLink);

    let actions = "";
    if (kind === "rejected" && data.canApprove) {
      actions += `<button class="btn-small btn-approve" data-modal-approve="${data.id}">Aprovar</button>`;
    }
    if (kind === "deal" && data.affiliateLink) {
      actions += `<button class="btn-small btn-link" data-modal-copy-link="${data.affiliateLink}">Copiar link</button>`;
    }
    if (kind === "deal" && data.approvedManually) {
      actions += `<button class="btn-small btn-revert" data-modal-revert="${data.id}">Desfazer</button>`;
    }
    if (kind === "deal" && !data.approvedManually) {
      actions += `<button class="btn-small btn-danger" data-modal-reject="${data.id}">Rejeitar</button>`;
    }
    if (actions) html += `<div class="modal-actions">${actions}</div>`;

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<p class="msg error">${e.message}</p>`;
  }
}

function closeDetailModal() {
  document.getElementById("detail-modal").hidden = true;
}

// Cada campo agora tem um "group" (categoria) além dos dados que já tinha -
// isso é o que permite agrupar as configurações em seções, em vez de uma
// lista única de 11 campos difícil de escanear.
const SETTINGS_FIELDS = [
  {
    key: "minDiscountPercent",
    label: "Desconto mínimo (%)",
    step: "1",
    nullable: true,
    group: "quality",
    hint: 'Desconto mínimo que uma oferta precisa ter para ser aprovada automaticamente. Ofertas com desconto menor são rejeitadas (motivo: DISCOUNT_BELOW_MINIMUM). Unidade: porcentagem (%). "Sem limite" aceita qualquer desconto, inclusive 0%.',
  },
  {
    key: "minPrice",
    label: "Preço mínimo (R$)",
    step: "0.01",
    nullable: true,
    group: "quality",
    hint: 'Preço mínimo que o produto precisa ter para ser considerado. Ofertas mais baratas que isso são rejeitadas. Unidade: reais (R$). "Sem limite" remove esse piso de preço.',
  },
  {
    key: "maxPrice",
    label: "Preço máximo (R$)",
    step: "0.01",
    nullable: true,
    group: "quality",
    hint: 'Preço máximo permitido. Ofertas mais caras que isso são rejeitadas. Unidade: reais (R$). "Sem limite" permite qualquer preço, por mais caro que seja.',
  },
  {
    key: "minRating",
    label: "Avaliação mínima",
    step: "0.1",
    nullable: true,
    group: "quality",
    hint: 'Nota mínima de avaliação do produto, de 0 a 5. Produtos com nota abaixo disso são rejeitados. "Sem limite" aceita qualquer nota, inclusive produtos ainda sem avaliação.',
  },
  {
    key: "minRatingCount",
    label: "Mín. de avaliações",
    step: "1",
    nullable: true,
    group: "quality",
    hint: 'Quantidade mínima de avaliações que o produto precisa ter, para evitar produtos novos e pouco testados. Unidade: quantidade de avaliações. Atenção: a API real da Shopee não informa esse número — normalmente convém deixar "Sem limite" em produção, ou esse filtro rejeita tudo.',
  },
  {
    key: "minSalesCount",
    label: "Mín. de vendas",
    step: "1",
    nullable: true,
    group: "quality",
    hint: 'Quantidade mínima de unidades já vendidas do produto, usada como sinal de confiabilidade. Unidade: unidades vendidas. "Sem limite" aceita produtos sem histórico de vendas.',
  },
  {
    key: "minCommissionPercent",
    label: "Comissão mínima (%)",
    step: "0.1",
    nullable: true,
    group: "quality",
    hint: 'Comissão mínima que a oferta precisa pagar para valer a pena aprovar. Unidade: porcentagem (%) sobre o valor da venda. "Sem limite" aceita qualquer comissão, inclusive próxima de 0%.',
  },
  {
    key: "maxOffersFetchedPerRound",
    label: "Máx. ofertas buscadas",
    step: "1",
    nullable: true,
    group: "volume",
    hint: 'Quantos produtos no máximo o sistema busca na Shopee, antes dos filtros. O escopo (rodada inteira ou por categoria) é escolhido em "Modo de busca e categorias". É diferente de "Máx. ofertas aprovadas por rodada".',
  },
  {
    key: "maxOffersPerRound",
    label: "Máx. ofertas aprovadas por rodada",
    step: "1",
    nullable: true,
    group: "volume",
    hint: 'Quantidade máxima de ofertas aprovadas numa única execução. As ofertas adicionais que passarem nos filtros continuam sendo registradas como rejeitadas pelo limite da rodada. "Sem limite" aprova todas as ofertas válidas buscadas.',
  },
  {
    key: "maxOffersPerDay",
    label: "Máx. ofertas por dia",
    step: "1",
    nullable: true,
    group: "volume",
    hint: 'Quantidade máxima de ofertas aprovadas no dia inteiro, somando todas as execuções. Ao atingir esse número, NENHUMA nova execução roda (nem automática, nem manual) até o dia virar ou você aumentar o limite. "Sem limite" remove esse teto diário.',
  },
  {
    key: "minDaysBeforeRepublish",
    label: "Dias antes de republicar",
    step: "1",
    nullable: true,
    group: "volume",
    hint: 'Quantos dias o sistema espera antes de aprovar o mesmo produto de novo, mesmo que ele volte a aparecer nas buscas. Evita repetir a mesma oferta com frequência. Unidade: dias. "Sem limite" permite aprovar o mesmo produto em execuções seguidas, sem esperar.',
  },
  {
    key: "intervalBetweenRoundsMinutes",
    label: "Intervalo entre rodadas (min)",
    step: "1",
    nullable: false,
    group: "schedule",
    hint: 'Intervalo mínimo entre uma execução automática do scheduler e a próxima. Não afeta cliques manuais em "Executar agora", que sempre rodam na hora. Unidade: minutos.',
  },
];

const SETTINGS_GROUP_CONTAINER_ID = {
  quality: "settings-fields-quality",
  volume: "settings-fields-volume",
  schedule: "settings-fields-schedule",
};

function renderSettingsFields() {
  for (const containerId of Object.values(SETTINGS_GROUP_CONTAINER_ID)) {
    document.getElementById(containerId).innerHTML = "";
  }

  for (const f of SETTINGS_FIELDS) {
    const toggle = f.nullable
      ? `<button type="button" class="btn-toggle-limit" data-toggle-limit="${f.key}">Sem limite</button>`
      : "";
    const tooltip = f.hint
      ? `<span class="info-icon" data-tooltip="${f.hint.replace(/"/g, "&quot;")}" tabindex="0">?</span>`
      : "";
    const fieldHtml = `
      <label>${f.label}${tooltip}</label>
      <div class="setting-row">
        <input class="setting-input" id="cfg-${f.key}" type="number" step="${f.step}" />
        ${toggle}
      </div>
    `;
    document
      .getElementById(SETTINGS_GROUP_CONTAINER_ID[f.group])
      .insertAdjacentHTML("beforeend", fieldHtml);
  }

  for (const f of SETTINGS_FIELDS.filter((x) => x.nullable)) {
    document
      .querySelector(`[data-toggle-limit="${f.key}"]`)
      .addEventListener("click", () => {
        const input = document.getElementById(`cfg-${f.key}`);
        const nowUnlimited = input.dataset.unlimited !== "true";
        input.dataset.unlimited = String(nowUnlimited);
        input.disabled = nowUnlimited;
        document
          .querySelector(`[data-toggle-limit="${f.key}"]`)
          .classList.toggle("active", nowUnlimited);
      });
  }
}

// Estado local das categorias (evita ir ao servidor a cada edição pequena;
// só é persistido quando o usuário clica "Salvar configurações").
let localCategories = [];

async function loadSettings() {
  const s = await api("/api/settings");
  for (const f of SETTINGS_FIELDS) {
    const input = document.getElementById(`cfg-${f.key}`);
    const value = s[f.key];
    const toggleBtn = document.querySelector(`[data-toggle-limit="${f.key}"]`);
    if (f.nullable && value === null) {
      input.value = "";
      input.disabled = true;
      input.dataset.unlimited = "true";
      if (toggleBtn) toggleBtn.classList.add("active");
    } else {
      input.value = value;
      input.disabled = false;
      input.dataset.unlimited = "false";
      if (toggleBtn) toggleBtn.classList.remove("active");
    }
  }
  document.getElementById("cfg-searchMode").value =
    s.searchMode || "ALL_PRODUCTS";
  updateSearchLimitScope(s.searchLimitScope || "ROUND");
  localCategories = s.keywordCategories || [];
  renderCategories();
  renderSearchPreview();
}

async function saveSettings() {
  const payload = {};
  for (const f of SETTINGS_FIELDS) {
    const input = document.getElementById(`cfg-${f.key}`);
    payload[f.key] =
      f.nullable && input.dataset.unlimited === "true"
        ? null
        : Number(input.value);
  }
  payload.searchMode = document.getElementById("cfg-searchMode").value;
  payload.searchLimitScope =
    document.querySelector("[data-search-limit-scope].active")?.dataset.searchLimitScope || "ROUND";
  payload.keywordCategories = localCategories;
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    showToast("Configurações salvas.", "success");
  } catch (e) {
    showToast(e.message, "error");
  }
}

// --- Gestão de categorias/palavras-chave ---

function renderSearchPreview() {
  const mode = document.getElementById("cfg-searchMode").value;
  const scope = document.querySelector("[data-search-limit-scope].active")?.dataset.searchLimitScope || "ROUND";
  const limitInput = document.getElementById("cfg-maxOffersFetchedPerRound");
  const limit =
    limitInput?.dataset.unlimited === "true"
      ? null
      : limitInput?.value.trim() === ""
        ? Number.NaN
        : Number(limitInput?.value);
  const hint = document.getElementById("search-limit-hint");
  const categoriesPanel = document.getElementById("categories-panel");
  const el = document.getElementById("search-preview");
  for (const button of document.querySelectorAll("[data-search-limit-scope]")) {
    button.disabled = mode !== "CATEGORIES" && button.dataset.searchLimitScope === "CATEGORY";
  }
  categoriesPanel.hidden = mode !== "CATEGORIES";
  const selected = localCategories.filter((category) => category.selected);
  const hasCategoryKeywords = selected.some((category) =>
    category.keywords.some((keyword) => keyword.trim()),
  );
  const usesCategoryLimit = mode === "CATEGORIES" && scope === "CATEGORY" && hasCategoryKeywords;
  hint.textContent =
    Number.isNaN(limit)
      ? 'Informe um limite válido ou selecione "Sem limite".'
      : limit === null
        ? usesCategoryLimit
          ? "Sem limite de ofertas buscadas por categoria."
          : "Sem limite de ofertas buscadas na rodada."
        : usesCategoryLimit
          ? `Até ${limit} itens serão buscados por categoria selecionada. Se ela tiver várias palavras-chave, o limite será dividido entre elas.`
          : `Até ${limit} itens serão buscados no total da rodada.`;
  if (mode !== "CATEGORIES") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (selected.length === 0 || selected.every((category) => !category.keywords.some((keyword) => keyword.trim()))) {
    el.innerHTML = "<strong>Nenhuma palavra-chave selecionada.</strong> A busca será feita em todos os produtos.";
    return;
  }
  el.innerHTML = `<strong>Busca por categoria</strong>${selected.map((category) => {
    const keywords = [...new Map(
      category.keywords
        .map((keyword) => keyword.trim())
        .filter(Boolean)
        .map((keyword) => [keyword.toLowerCase(), keyword]),
    ).values()];
    return `<div class="search-preview-category"><b>${escapeHTML(category.name || "Categoria sem nome")}</b>: ${
      keywords.length ? keywords.map(escapeHTML).join(", ") : "sem palavras-chave"
    }${keywords.length > 0 && scope === "CATEGORY" && limit !== null && Number.isFinite(limit) ? ` <span>(até ${limit} itens)</span>` : ""}</div>`;
  }).join("")}`;
}

function updateSearchLimitScope(scope) {
  for (const button of document.querySelectorAll("[data-search-limit-scope]")) {
    const active = button.dataset.searchLimitScope === scope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  renderSearchPreview();
}

function escapeHTML(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function renderCategories() {
  const container = document.getElementById("categories-list");

  if (!container) return;
  refreshConfiguredCategoryHues();

  container.innerHTML = "";

  if (localCategories.length === 0) {
    container.innerHTML = `
      <p class="empty-hint">
        Nenhuma categoria criada ainda.
      </p>
    `;
    return;
  }

  for (const cat of localCategories) {
    const div = document.createElement("div");
    div.className = "category-card";

    const keywords = Array.isArray(cat.keywords) ? cat.keywords : [];

    div.innerHTML = `
      <div class="category-header">
        <label class="category-select">
          <input
            type="checkbox"
            ${cat.selected ? "checked" : ""}
            data-cat-select="${escapeHTML(cat.id)}"
            aria-label="Buscar palavras-chave do grupo ${escapeHTML(cat.name)}"
          />
        </label>

        <input
          type="text"
          class="category-name-input"
          data-cat-name="${escapeHTML(cat.id)}"
          aria-label="Nome do grupo de busca"
          placeholder="Nome do grupo"
          value="${escapeHTML(cat.name)}"
        />

        <button
          type="button"
          class="btn-small btn-danger"
          data-cat-delete="${escapeHTML(cat.id)}"
        >
          Excluir
        </button>
      </div>

      <div class="category-keywords-label">Palavras-chave pesquisadas na Shopee</div>
      <div class="keyword-list" id="kw-list-${escapeHTML(cat.id)}">
        ${
          keywords.length
            ? keywords
                .map(
                  (kw) => `
                <span class="keyword-chip">
                  <span class="keyword-text">${escapeHTML(kw)}</span>
                  <button
                    type="button"
                    class="keyword-remove"
                    data-kw-delete="${escapeHTML(cat.id)}"
                    data-kw="${escapeHTML(kw)}"
                    aria-label="Remover palavra-chave ${escapeHTML(kw)}"
                  >&times;</button>
                </span>
              `,
                )
                .join("")
            : `<span class="empty-hint">Nenhuma palavra-chave adicionada.</span>`
        }
      </div>

      <div class="keyword-add-row">
        <input
          type="text"
          class="keyword-input"
          placeholder="Nova palavra-chave..."
          id="kw-input-${escapeHTML(cat.id)}"
          aria-label="Nova palavra-chave para ${escapeHTML(cat.name)}"
        />

        <button
          type="button"
          class="btn-small btn-secondary"
          data-kw-add="${escapeHTML(cat.id)}"
        >
          Adicionar
        </button>
      </div>
    `;

    container.appendChild(div);
  }
}

document
  .getElementById("cfg-searchMode")
  .addEventListener("change", renderSearchPreview);

for (const button of document.querySelectorAll("[data-search-limit-scope]")) {
  button.addEventListener("click", () => updateSearchLimitScope(button.dataset.searchLimitScope));
}

document.getElementById("settings-fields-volume").addEventListener("input", (event) => {
  if (event.target.id === "cfg-maxOffersFetchedPerRound") renderSearchPreview();
});
document.getElementById("settings-fields-volume").addEventListener("click", (event) => {
  if (event.target.dataset.toggleLimit === "maxOffersFetchedPerRound") {
    renderSearchPreview();
  }
});

document.getElementById("btn-add-category").addEventListener("click", () => {
  const id = "cat-" + Date.now();
  localCategories.push({
    id,
    name: "Nova categoria",
    keywords: [],
    selected: false,
  });
  renderCategories();
  renderSearchPreview();
});

document.getElementById("categories-list").addEventListener("change", (e) => {
  const catId = e.target.dataset.catSelect;
  if (catId) {
    const cat = localCategories.find((c) => c.id === catId);
    if (cat) {
      cat.selected = e.target.checked;
      renderSearchPreview();
    }
  }
});

document.getElementById("categories-list").addEventListener("input", (e) => {
  const catId = e.target.dataset.catName;
  if (!catId) return;
  const cat = localCategories.find((item) => item.id === catId);
  if (cat) {
    cat.name = e.target.value.trim() || "Categoria sem nome";
    renderSearchPreview();
  }
});

document.getElementById("categories-list").addEventListener(
  "blur",
  (e) => {
    const catId = e.target.dataset.catName;
    if (catId) {
      const cat = localCategories.find((c) => c.id === catId);
      if (cat && !e.target.value.trim()) cat.name = "Categoria sem nome";
    }
  },
  true,
);

document.getElementById("categories-list").addEventListener("click", (e) => {
  const catId = e.target.dataset.catDelete;
  if (catId) {
    if (!confirm("Excluir esta categoria e todas as suas palavras-chave?"))
      return;
    localCategories = localCategories.filter((c) => c.id !== catId);
    renderCategories();
    renderSearchPreview();
    return;
  }
  const kwAddCatId = e.target.dataset.kwAdd;
  if (kwAddCatId) {
    const input = document.getElementById(`kw-input-${kwAddCatId}`);
    const kw = input.value.trim();
    if (!kw) return;
    const cat = localCategories.find((c) => c.id === kwAddCatId);
    if (cat && !cat.keywords.some((keyword) => keyword.trim().toLowerCase() === kw.toLowerCase())) {
      cat.keywords.push(kw);
      input.value = "";
      renderCategories();
      renderSearchPreview();
    }
    return;
  }
  const kwDeleteCatId = e.target.dataset.kwDelete;
  if (kwDeleteCatId) {
    const kw = e.target.dataset.kw;
    const cat = localCategories.find((c) => c.id === kwDeleteCatId);
    if (cat) {
      cat.keywords = cat.keywords.filter((k) => k !== kw);
      renderCategories();
      renderSearchPreview();
    }
  }
});

document.getElementById("categories-list").addEventListener("keydown", (e) => {
  const kwAddCatId = e.target.id?.replace("kw-input-", "");
  if (
    kwAddCatId &&
    localCategories.find((c) => c.id === kwAddCatId) &&
    e.key === "Enter"
  ) {
    const kw = e.target.value.trim();
    if (!kw) return;
    const cat = localCategories.find((c) => c.id === kwAddCatId);
    if (cat && !cat.keywords.some((keyword) => keyword.trim().toLowerCase() === kw.toLowerCase())) {
      cat.keywords.push(kw);
      e.target.value = "";
      renderCategories();
      renderSearchPreview();
    }
  }
});

async function runNow() {
  const btn = document.getElementById("btn-run-now");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Executando…";
  try {
    const result = await api("/api/run-now", { method: "POST" });
    showToast(
      `Concluído: ${result.dealsSelected} selecionada(s), ${result.productsFiltered} rejeitada(s), ${result.errorsCount} erro(s).`,
      "success",
    );
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function toggleAutomation() {
  const action = currentAutomationEnabled ? "pause" : "resume";
  try {
    await api("/api/kill-switch", {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    showToast(
      action === "pause" ? "Automação pausada." : "Automação retomada.",
      "success",
    );
    loadDashboard();
  } catch (e) {
    showToast(e.message, "error");
  }
}

async function wipeAllOffers() {
  if (
    !confirm(
      "Apagar TODAS as ofertas (aprovadas e rejeitadas), sem volta? Use isso só pra resetar o banco entre testes.",
    )
  ) {
    return;
  }
  try {
    const result = await api("/api/testing/wipe-offers", { method: "POST" });
    showToast(
      `Limpo: ${result.deletedDeals} aprovada(s) e ${result.deletedRejections} rejeitada(s) apagadas.`,
      "success",
    );
    refreshAll();
  } catch (e) {
    showToast(e.message, "error");
  }
}

renderSettingsFields();

document.getElementById("btn-login").addEventListener("click", login);
document.getElementById("btn-run-now").addEventListener("click", runNow);
document
  .getElementById("btn-toggle-automation")
  .addEventListener("click", toggleAutomation);
document
  .getElementById("btn-wipe-offers")
  .addEventListener("click", wipeAllOffers);
document
  .getElementById("btn-save-settings")
  .addEventListener("click", saveSettings);

for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
}

for (const btn of document.querySelectorAll("[data-offers-tab]")) {
  btn.addEventListener("click", () => switchOffersTab(btn.dataset.offersTab));
}

document.getElementById("rejected-list").addEventListener("click", (event) => {
  const approveBtn = event.target.closest("[data-approve]");
  if (approveBtn) {
    approveOffer(approveBtn.dataset.approve);
    return;
  }
  const card = event.target.closest(".offer-card[data-detail-id]");
  if (card) openDetailModal(card.dataset.detailKind, card.dataset.detailId);
});

document.getElementById("rejected-period").addEventListener("change", () => {
  loadRejected();
});

document
  .getElementById("btn-toggle-rejected")
  .addEventListener("click", toggleRejectedVisibility);
document
  .getElementById("btn-delete-rejected")
  .addEventListener("click", deleteAllRejected);

document.getElementById("deals-list").addEventListener("click", (event) => {
  const copyBtn = event.target.closest("[data-copy-link]");
  if (copyBtn) {
    copyAffiliateLink(copyBtn.dataset.copyLink, copyBtn);
    return;
  }
  const revertBtn = event.target.closest("[data-revert]");
  if (revertBtn) {
    revertDeal(revertBtn.dataset.revert);
    return;
  }
  const rejectBtn = event.target.closest("[data-reject]");
  if (rejectBtn) {
    rejectDeal(rejectBtn.dataset.reject);
    return;
  }
  const card = event.target.closest(".offer-card[data-detail-id]");
  if (card) openDetailModal(card.dataset.detailKind, card.dataset.detailId);
});

// --- Fechar o modal: botão X, clique fora da caixa, ou tecla Esc ---
document
  .getElementById("modal-close-btn")
  .addEventListener("click", closeDetailModal);
document.getElementById("detail-modal").addEventListener("click", (event) => {
  if (event.target.id === "detail-modal") closeDetailModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("detail-modal").hidden)
    closeDetailModal();
});

// --- Ações dentro do modal (aprovar / copiar link / desfazer / rejeitar) ---
document.getElementById("modal-content").addEventListener("click", (event) => {
  const approveBtn = event.target.closest("[data-modal-approve]");
  if (approveBtn) {
    closeDetailModal();
    approveOffer(approveBtn.dataset.modalApprove);
    return;
  }
  const copyBtn = event.target.closest("[data-modal-copy-link]");
  if (copyBtn) {
    copyAffiliateLink(copyBtn.dataset.modalCopyLink, copyBtn);
    return;
  }
  const revertBtn = event.target.closest("[data-modal-revert]");
  if (revertBtn) {
    closeDetailModal();
    revertDeal(revertBtn.dataset.modalRevert);
    return;
  }
  const rejectBtn = event.target.closest("[data-modal-reject]");
  if (rejectBtn) {
    closeDetailModal();
    rejectDeal(rejectBtn.dataset.modalReject);
    return;
  }
});

for (const id of ["login-email", "login-password"]) {
  document.getElementById(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
}

api("/api/dashboard")
  .then(showApp)
  .catch(() => showLogin());

// Atualiza o status (dashboard) sozinho, sem precisar recarregar a página -
// útil pra observar em tempo real se/quando o scheduler dispara automaticamente.
setInterval(() => {
  if (document.getElementById("app").style.display !== "none") {
    loadDashboard().catch(() => {});
  }
}, 15_000);
