async function api(path, opts) {
    const hasBody = opts && opts.body !== undefined;
    const headers = hasBody ? { "Content-Type": "application/json" } : {};
    const res = await fetch(path, { headers, ...opts });
    if (res.status === 401) { showLogin(); throw new Error("not authenticated"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
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
      await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
      showApp();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg error";
    }
  }

  async function refreshAll() {
    await Promise.all([loadDashboard(), loadRuns(), loadSettings(), loadRejected(), loadDeals()]);
  }

  async function loadDashboard() {
    const d = await api("/api/dashboard");
    document.getElementById("stat-mode").textContent = d.effectiveMode;
    document.getElementById("stat-active").textContent = d.hasActiveRun ? "Sim" : "Não";
    document.getElementById("stat-last").textContent = d.lastFinishedAt ? new Date(d.lastFinishedAt).toLocaleString("pt-BR") : "nunca";
    document.getElementById("stat-hours").textContent = d.operatingHours.start + "h – " + d.operatingHours.end + "h";
    document.getElementById("stat-version").textContent = d.version;
  }

  async function loadRuns() {
    const runs = await api("/api/runs?limit=10");
    const tbody = document.querySelector("#runs-table tbody");
    tbody.innerHTML = "";
    for (const r of runs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${new Date(r.startedAt).toLocaleString("pt-BR")}</td><td>${r.mode}</td><td>${r.status}</td><td>${r.dealsSelected}</td><td>${r.errorsCount}</td>`;
      tbody.appendChild(tr);
    }
  }

  async function loadRejected() {
    const rows = await api("/api/rejections?limit=20");
    const container = document.getElementById("rejected-list");
    container.innerHTML = "";
    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-hint">Nenhuma rejeição recente.</p>';
      return;
    }
    for (const r of rows) {
      const div = document.createElement("div");
      div.className = "offer-row";
      const approveButton = r.canApprove
        ? `<button class="btn-approve" data-approve="${r.id}">Aprovar</button>`
        : r.manuallyApprovedAt
          ? '<span class="pill ok">aprovada</span>'
          : "";
      div.innerHTML = `
        <div>
          <div class="offer-name">${r.productName || r.shopeeItemId}</div>
          <div class="offer-reason">${r.reason}${r.details ? " — " + r.details : ""}</div>
        </div>
        ${approveButton}
      `;
      container.appendChild(div);
    }
  }

  async function approveOffer(id) {
    const msg = document.getElementById("action-msg");
    try {
      await api(`/api/rejections/${id}/approve`, { method: "POST" });
      msg.textContent = "Oferta aprovada manualmente.";
      msg.className = "msg success";
      refreshAll();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg error";
    }
  }

  async function loadDeals() {
    const rows = await api("/api/deals?limit=20");
    const container = document.getElementById("deals-list");
    container.innerHTML = "";
    if (rows.length === 0) {
      container.innerHTML = '<p class="empty-hint">Nenhuma oferta publicada ainda.</p>';
      return;
    }
    for (const d of rows) {
      const div = document.createElement("div");
      div.className = "offer-row";
      const productName = d.product ? d.product.name : d.productName;
      const badge = d.approvedManually ? '<span class="pill warn">manual</span>' : "";
      div.innerHTML = `
        <div>
          <div class="offer-name">${productName}</div>
          <div class="offer-reason">R$ ${Number(d.priceAtPublish).toFixed(2)} · score ${Number(d.dealScore).toFixed(0)} · ${d.channel}</div>
        </div>
        ${badge}
      `;
      container.appendChild(div);
    }
  }

  async function loadSettings() {
    const s = await api("/api/settings");
    document.getElementById("cfg-minDiscountPercent").value = s.minDiscountPercent;
    document.getElementById("cfg-minRating").value = s.minRating;
    document.getElementById("cfg-maxOffersPerRound").value = s.maxOffersPerRound;
    document.getElementById("cfg-maxOffersPerDay").value = s.maxOffersPerDay;
    document.getElementById("cfg-intervalBetweenRoundsMinutes").value = s.intervalBetweenRoundsMinutes;
  }

  async function saveSettings() {
    const msg = document.getElementById("settings-msg");
    msg.textContent = "";
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({
        minDiscountPercent: Number(document.getElementById("cfg-minDiscountPercent").value),
        minRating: Number(document.getElementById("cfg-minRating").value),
        maxOffersPerRound: Number(document.getElementById("cfg-maxOffersPerRound").value),
        maxOffersPerDay: Number(document.getElementById("cfg-maxOffersPerDay").value),
        intervalBetweenRoundsMinutes: Number(document.getElementById("cfg-intervalBetweenRoundsMinutes").value),
      })});
      msg.textContent = "Configurações salvas.";
      msg.className = "msg success";
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg error";
    }
  }

  async function runNow() {
    const msg = document.getElementById("action-msg");
    msg.textContent = "Executando...";
    msg.className = "msg";
    try {
      const result = await api("/api/run-now", { method: "POST" });
      msg.textContent = `Concluído: ${result.dealsSelected} selecionadas, ${result.productsFiltered} rejeitadas, ${result.errorsCount} erros.`;
      msg.className = "msg success";
      refreshAll();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg error";
    }
  }

  async function killSwitch(action) {
    const msg = document.getElementById("action-msg");
    try {
      await api("/api/kill-switch", { method: "POST", body: JSON.stringify({ action }) });
      msg.textContent = "Atualizado.";
      msg.className = "msg success";
      refreshAll();
    } catch (e) {
      msg.textContent = e.message;
      msg.className = "msg error";
    }
  }

  // --- Registro de eventos ---
  // Tudo via addEventListener: atributos onclick inline são bloqueados pela
  // Content Security Policy do Helmet (script-src-attr 'none').
  document.getElementById("btn-login").addEventListener("click", login);
  document.getElementById("btn-run-now").addEventListener("click", runNow);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

  for (const btn of document.querySelectorAll("[data-kill]")) {
    btn.addEventListener("click", () => killSwitch(btn.dataset.kill));
  }

  // Botões "Aprovar" são criados dinamicamente, então usamos delegação de
  // evento no container, que existe desde o início.
  document.getElementById("rejected-list").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-approve]");
    if (btn) approveOffer(btn.dataset.approve);
  });

  // Permite entrar apertando Enter nos campos de login.
  for (const id of ["login-email", "login-password"]) {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") login();
    });
  }

  // Tenta carregar o dashboard direto; se der 401, mostra tela de login.
  api("/api/dashboard").then(showApp).catch(() => showLogin());
