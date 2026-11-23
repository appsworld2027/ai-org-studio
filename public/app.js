// AI Org Studio — browser side. Left: one terminal per engine. Right: real app, prototype, agents.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    for (const k of kids) e.append(k);
    return e;
  };
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  let cfg = null, ws = null, engine = store.get("studio.engine", "claude"), board = null, lastAppUrl = "";

  // ---------- terminal ----------
  const term = new window.Terminal({ fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace', fontSize: 14, cursorBlink: true, scrollback: 5000, allowProposedApi: false,
    theme: { background: "#10171E", foreground: "#D9E2EA", cursor: "#8FD3C4", selectionBackground: "#2E4A5C" } });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, "_blank", "noopener")));
  term.open($("#term"));
  const sendJ = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const refit = () => { try { fit.fit(); sendJ({ t: "resize", cols: term.cols, rows: term.rows }); } catch { /* hidden */ } };
  term.onData((d) => sendJ({ t: "in", d }));
  new ResizeObserver(() => refit()).observe($("#term"));

  let retry = 0, retryTimer = null;
  function connect(mode) {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); }
    term.reset();
    $("#termState").textContent = `Connecting to ${nameOf(engine)}…`;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/pty?engine=${engine}${mode ? `&mode=${mode}` : ""}`);
    ws.onopen = () => { retry = 0; $("#termState").textContent = `${nameOf(engine)} · type below`; $("#termMsg").hidden = true; refit(); term.focus(); markRunning(engine, true); };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => {
      $("#termState").textContent = "Disconnected. Reconnecting…";
      retryTimer = setTimeout(() => connect(), Math.min(15000, 1000 * 2 ** retry++));
      if (retry > 2) { $("#termMsg").hidden = false; $("#termMsg").textContent = "The Studio server is not reachable. If Cloud Shell went to sleep, start it again with: bash ~/ai-org-studio/bin/studio.sh"; }
    };
  }
  const nameOf = (id) => cfg?.engines.find((e) => e.id === id)?.name || id;
  function markRunning(id, on) { const b = document.querySelector(`.eng[data-eng="${id}"]`); if (b) b.classList.toggle("running", on); }
  function pickEngine(id) {
    engine = id; store.set("studio.engine", id);
    document.querySelectorAll(".eng").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.eng === id)));
    connect();
  }
  $("#btnRestart").onclick = () => { if (ws?.readyState === 1) { term.reset(); sendJ({ t: "restart", mode: "new" }); } else connect("new"); };
  $("#btnContinue").onclick = () => { if (ws?.readyState === 1) { term.reset(); sendJ({ t: "restart", mode: "continue" }); } else connect("continue"); };

  // ---------- resizable split ----------
  const split = $("#split"), div = $("#divider");
  const setLeft = (pct) => { pct = Math.max(25, Math.min(70, pct)); split.style.setProperty("--left", pct + "%"); store.set("studio.left", String(pct)); };
  setLeft(Number(store.get("studio.left", "42")));
  div.addEventListener("pointerdown", (e) => {
    div.setPointerCapture(e.pointerId);
    const move = (ev) => setLeft(((ev.clientX - split.getBoundingClientRect().left) / split.clientWidth) * 100);
    const up = () => { div.removeEventListener("pointermove", move); div.removeEventListener("pointerup", up); refit(); };
    div.addEventListener("pointermove", move); div.addEventListener("pointerup", up);
    document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "none"));
    div.addEventListener("pointerup", () => document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "")), { once: true });
  });
  div.addEventListener("keydown", (e) => { const cur = parseFloat(getComputedStyle(split).getPropertyValue("--left")); if (e.key === "ArrowLeft") setLeft(cur - 3); if (e.key === "ArrowRight") setLeft(cur + 3); refit(); });

  // ---------- right tabs ----------
  let tab = store.get("studio.tab", "");
  function showTab(p) {
    tab = p; store.set("studio.tab", p);
    for (const t of ["app", "proto", "agents"]) {
      $(`#tab-${t}`).setAttribute("aria-selected", String(t === p));
      $(`#pane-${t}`).classList.toggle("show", t === p);
    }
    const href = p === "app" ? lastAppUrl : p === "proto" ? $("#protoFrame").getAttribute("src") : `https://github.com/${cfg?.product.repo}/issues?q=is%3Aopen+label%3Aai%3A*`;
    $("#openTab").hidden = !href; if (href) $("#openTab").href = href;
    $("#openTab").textContent = p === "agents" ? "Open on GitHub" : "Open in new tab";
  }
  document.querySelectorAll(".rtab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.pane)));
  $(".rtabs").addEventListener("keydown", (e) => {
    const order = ["app", "proto", "agents"], i = order.indexOf(tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = order[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; showTab(n); $(`#tab-${n}`).focus(); }
  });

  function setApp(app) {
    const banner = $("#appBanner");
    if (app.kind === "none") { $("#appFrame").hidden = true; $("#appEmpty").hidden = false; banner.hidden = true; lastAppUrl = ""; return; }
    $("#appFrame").hidden = false; $("#appEmpty").hidden = true; banner.hidden = false;
    banner.className = "banner" + (app.kind === "preview" ? " preview" : "");
    banner.replaceChildren(el("b", { text: app.kind === "preview" ? app.label : "Production" }),
      el("span", { text: app.kind === "preview" ? "Ready to test. Try it here, then tell the AI on the left: approve, or what to change." : "The live app. When a feature is ready to test, its preview opens here automatically." }));
    if (app.url !== lastAppUrl) {
      const wasPreview = lastAppUrl && app.kind === "preview";
      lastAppUrl = app.url; $("#appFrame").src = app.url;
      if (wasPreview || (app.kind === "preview" && tab !== "app")) showTab("app");
    }
    if (tab === "app") $("#openTab").href = app.url;
  }

  // ---------- agents board ----------
  const KIND = { agent: "an agent is working", founder: "waiting for you", loop: "automatic checks", blocked: "blocked", done: "done", queued: "not started" };
  const initials = (who) => /^(An?|The)\b|AI Org|loop/i.test(who) ? "AI" : /^QA/.test(who) ? "QA" : who.charAt(0).toUpperCase();
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
  function renderBoard(b) {
    board = b;
    const st = $("#boardStatus");
    st.className = "statusline" + (b.error ? " err" : "");
    st.textContent = b.error ? `Agent status could not refresh (${b.error}). Showing what was last loaded at ${new Date(b.updatedAt).toLocaleTimeString()}.` : `Live from GitHub · updated ${new Date(b.updatedAt).toLocaleTimeString()}`;
    // working now
    const run = $("#running"); run.replaceChildren();
    if (!b.working.length) run.append(el("div", { class: "idle", text: b.next ? `No agents working. Next on the backlog: ${b.next.title}.` : "No agents working right now." }));
    for (const w of b.working) {
      const cls = /QA lab/.test(w.who) ? "av qa" : /loop/i.test(w.who) ? "av loop" : "av";
      run.append(el("a", { class: "runner", href: w.url, target: "_blank", rel: "noopener" }, el("span", { class: cls, text: initials(w.who) }),
        el("span", {}, el("b", { text: w.who }), el("small", { text: `${w.what} · ${w.minutes} min` }))));
    }
    const badge = $("#workingBadge"); badge.hidden = !b.working.length; badge.textContent = `${b.working.length} working`;
    // waiting for you
    $("#waitingWrap").hidden = !b.waiting.length;
    $("#waiting").replaceChildren(...b.waiting.map((r) => el("div", { class: "wait" }, el("b", { text: r.title }),
      el("small", { text: r.stage === "approve" ? "Its Feature Contract is ready. Ask the AI on the left for the 2-minute summary, then approve or request a change." : "Ready for your test. Try it in the Real app tab, then tell the AI: approve, or what to change." }))));
    // tracks
    const t = $("#tracks"); t.replaceChildren();
    t.append(el("div", { class: "trk head", role: "row" }, el("div", { role: "columnheader", text: "Feature" }), ...b.stages.map((s) => el("div", { role: "columnheader", text: s.name }))));
    for (const r of b.rows) {
      const at = b.stages.findIndex((s) => s.id === r.stage);
      const cells = b.stages.map((s, i) => {
        let k = "none";
        if (r.kind === "done") k = "done";
        else if (r.kind !== "queued") k = i < at ? "done" : i === at ? r.kind : "none";
        return el("div", { role: "cell", "aria-label": `${s.name}: ${KIND[k] || "not started"}` }, el("div", { class: `st ${k}` }));
      });
      const sub = r.kind === "queued" ? "queued on the backlog" : r.kind === "done" ? "shipped" : `${r.who} · ${KIND[r.kind]}`;
      t.append(el("div", { class: "trk", role: "row" }, el("div", { class: "name", role: "rowheader" }, el("b", { text: r.title }), el("small", { text: sub })), ...cells));
    }
    // feed
    $("#feed").replaceChildren(...(b.feed.length ? b.feed.map((f) => el("a", { href: f.url, target: "_blank", rel: "noopener" }, el("time", { text: ago(f.at) }), f.text)) : [el("div", { class: "idle", text: "Nothing yet." })]));
    // focus in the top bar: the item waiting for you, else the one an agent is on
    const focus = b.rows.find((r) => r.kind === "founder") || b.rows.find((r) => r.kind === "agent" || r.kind === "loop" || r.kind === "blocked");
    $("#focus").hidden = !focus;
    if (focus) { $("#focusTitle").textContent = focus.title; const p = $("#focusStage"); p.className = `stagepill ${focus.kind}`; p.textContent = focus.kind === "founder" ? "Waiting for your OK" : `${b.stages.find((s) => s.id === focus.stage)?.name || ""}: ${focus.who}`; }
    setApp(b.app);
  }
  async function poll() {
    try {
      const r = await fetch("/api/board", { cache: "no-store" });
      const d = await r.json();
      if (r.ok) renderBoard(d);
      else if (board) renderBoard({ ...board, error: d.error || `HTTP ${r.status}` });
      else { const s = $("#boardStatus"); s.className = "statusline err"; s.textContent = `Agent status could not load (${d.error || r.status}). The rest of the Studio keeps working.`; }
    } catch (e) {
      if (board) renderBoard({ ...board, error: "Studio server not reachable" });
    }
  }

  // ---------- start ----------
  (async () => {
    cfg = await (await fetch("/api/config", { cache: "no-store" })).json();
    $("#productName").textContent = cfg.product.name; document.title = `${cfg.product.name} · AI Org Studio`;
    $("#engines").replaceChildren(...cfg.engines.map((e) => {
      const b = el("button", { class: "eng" + (e.running ? " running" : ""), role: "tab", "data-eng": e.id, "aria-selected": String(e.id === engine) }, el("span", { class: "dot" }), e.name);
      b.onclick = () => pickEngine(e.id); return b;
    }));
    if (!cfg.engines.some((e) => e.id === engine)) engine = cfg.engines[0].id;
    const pick = $("#protoPick");
    pick.replaceChildren(...cfg.product.prototypes.map((p) => el("option", { value: p, text: p.replace(/\.html$/, "").replace(/_/g, " ") })));
    pick.onchange = () => { $("#protoFrame").src = `/proto/${encodeURIComponent(pick.value)}`; if (tab === "proto") $("#openTab").href = $("#protoFrame").getAttribute("src"); };
    if (cfg.product.prototypes.length) pick.onchange();
    setApp(cfg.product.productionUrl ? { kind: "production", url: cfg.product.productionUrl } : { kind: "none" });
    showTab(tab || (cfg.product.productionUrl ? "app" : "proto"));
    connect();
    poll(); setInterval(poll, cfg.boardRefreshMs);
  })();
})();
