// AI Org Studio — browser side. Product picker; left = Claude Code / Codex terminal or Studio-drawn chat; right = app, prototype, agents.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { cache: "no-store", ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
    let d = {}; try { d = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const wsUrl = (path) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
  let cfg = null, product = null, engine = store.get("studio.engine", "claude"), board = null, lastAppUrl = "", pollTimer = null;

  // ---------- terminal (Claude Code / Codex) ----------
  const term = new window.Terminal({ fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace', fontSize: 14, cursorBlink: true, scrollback: 5000,
    theme: { background: "#10171E", foreground: "#D9E2EA", cursor: "#8FD3C4", selectionBackground: "#2E4A5C" } });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new window.WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, "_blank", "noopener")));
  term.open($("#term"));
  let tws = null, retry = 0, retryTimer = null;
  const tsend = (m) => { if (tws && tws.readyState === 1) tws.send(JSON.stringify(m)); };
  const refit = () => { try { fit.fit(); tsend({ t: "resize", cols: term.cols, rows: term.rows }); } catch { /* hidden */ } };
  term.onData((d) => tsend({ t: "in", d }));
  new ResizeObserver(() => refit()).observe($("#term"));
  const nameOf = (id) => cfg.terminals.find((e) => e.id === id)?.name || "Other models";
  function connectTerm(mode) {
    clearTimeout(retryTimer);
    if (tws) { tws.onclose = null; tws.close(); }
    term.reset();
    $("#termState").textContent = `Connecting to ${nameOf(engine)}…`;
    tws = new WebSocket(wsUrl(`/pty?product=${product.id}&engine=${engine}${mode ? `&mode=${mode}` : ""}`));
    tws.onopen = () => { retry = 0; $("#termState").textContent = `${nameOf(engine)} · ${product.name}`; $("#termMsg").hidden = true; refit(); $("#tAsk").focus(); };
    tws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    tws.onclose = () => {
      if (engine === "other") return;
      $("#termState").textContent = "Disconnected. Reconnecting…";
      retryTimer = setTimeout(() => connectTerm(), Math.min(15000, 1000 * 2 ** retry++));
      if (retry > 2) { $("#termMsg").hidden = false; $("#termMsg").textContent = "The Studio server is not reachable. If the machine went to sleep, start it again: bash ~/ai-org-studio/bin/studio.sh"; }
    };
  }
  $("#btnRestart").onclick = () => { if (tws?.readyState === 1) { term.reset(); tsend({ t: "restart", mode: "new" }); } else connectTerm("new"); };
  $("#btnContinue").onclick = () => { if (tws?.readyState === 1) { term.reset(); tsend({ t: "restart", mode: "continue" }); } else connectTerm("continue"); };

  // ---------- chat composer under the Claude Code / Codex screen ----------
  // The official program keeps its own screen above; this box is just a friendlier way to type into it.
  // Attachments are uploaded into the product folder (.studio-uploads/, kept out of git) and referenced by path,
  // exactly as a user would type @path in the terminal. The message is delivered as one "paste", then Enter.
  const pending = []; // { id, name, path?, image, url?, el, state }
  const fmtSize = (n) => n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  function renderChip(a) {
    const kids = [a.url ? el("img", { src: a.url, alt: "" }) : el("span", { class: "fi", text: (a.name.split(".").pop() || "file").slice(0, 4).toUpperCase() }), el("span", { text: a.name, title: a.name })];
    const x = el("button", { type: "button", "aria-label": `Remove ${a.name}`, text: "×" }); x.onclick = () => { pending.splice(pending.indexOf(a), 1); a.el.remove(); };
    const c = el("div", { class: `chip ${a.state === "uploading" ? "up" : a.state === "error" ? "bad" : ""}`, title: a.error || `${a.name} · ${fmtSize(a.size)}` }, ...kids, x);
    if (a.el) a.el.replaceWith(c); else $("#tChips").append(c); a.el = c;
  }
  async function addFiles(files) {
    for (const f of files) {
      const a = { name: f.name || `pasted-${Date.now()}.png`, size: f.size, image: /^image\//.test(f.type), url: /^image\//.test(f.type) ? URL.createObjectURL(f) : "", state: "uploading" };
      pending.push(a); renderChip(a);
      if (f.size > 20 << 20) { Object.assign(a, { state: "error", error: "Larger than 20 MB" }); renderChip(a); continue; }
      try {
        const r = await fetch(`/api/products/${product.id}/uploads`, { method: "POST", headers: { "X-File-Name": encodeURIComponent(a.name) }, body: f });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        Object.assign(a, { state: "ready", path: d.path }); renderChip(a);
      } catch (e) { Object.assign(a, { state: "error", error: e.message }); renderChip(a); }
    }
  }
  $("#tAttach").onclick = () => $("#tFile").click();
  $("#tFile").onchange = () => { addFiles([...$("#tFile").files]); $("#tFile").value = ""; };
  $("#tAsk").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${i ? `-${i}` : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })))); }
  });
  const tc = $("#tComposer");
  tc.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); tc.classList.add("drag"); } });
  tc.addEventListener("dragleave", () => tc.classList.remove("drag"));
  tc.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) { e.preventDefault(); tc.classList.remove("drag"); addFiles([...e.dataTransfer.files]); } });
  $("#tAsk").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); tc.requestSubmit(); } });
  $("#tEsc").onclick = () => { tsend({ t: "in", d: "\x1b" }); term.focus(); };
  // How a reference to an attached file is written for each program: Claude Code uses @path, Codex reads plain paths.
  const refFor = (a) => (engine === "claude" ? `@${a.path}` : a.path);
  tc.onsubmit = (e) => {
    e.preventDefault();
    if (pending.some((a) => a.state === "uploading")) { $("#tHint").textContent = "Still uploading… one moment."; return; }
    const text = $("#tAsk").value.replace(/\r/g, "").trim(), files = pending.filter((a) => a.state === "ready");
    if (!text && !files.length) return;
    if (!tws || tws.readyState !== 1) { $("#tHint").textContent = "Not connected to the AI yet. Wait a moment, or press Restart."; return; }
    const message = [text, files.length ? `${text ? "\n\n" : ""}Attached: ${files.map(refFor).join(" ")}` : ""].join("");
    // Bracketed paste keeps line breaks inside the message instead of sending each line separately.
    tsend({ t: "in", d: "\x1b[200~" + message.replace(/\x1b/g, "") + "\x1b[201~" });
    setTimeout(() => tsend({ t: "in", d: "\r" }), 120);
    $("#tAsk").value = ""; for (const a of pending.splice(0)) a.el.remove();
    $("#tHint").textContent = "Sent. Watch the AI's screen above.";
    $("#tAsk").focus();
  };

  // ---------- Studio-drawn chat (Other models) ----------
  const chat = window.StudioChat.create({ box: $("#msgs"), onBusy: (b) => { $("#btnStop").hidden = !b; $("#btnSend").disabled = b; } });
  let chatId = "";
  const prov = () => cfg.providers.find((p) => p.id === $("#providerPick").value);
  async function loadModels(pid, keepModel) {
    const p = cfg.providers.find((x) => x.id === pid); const pick = $("#modelPick");
    let models = p.models || [];
    if (p.hasKey || !p.needsKey) { try { const r = await api(`/api/providers/${pid}`); models = r.models?.length ? r.models : models; } catch { /* keep defaults */ } }
    pick.replaceChildren(...models.map((m) => el("option", { value: m, text: m })));
    if (!models.length) pick.append(el("option", { value: "", text: p.needsKey && !p.hasKey ? "Add a key first" : "No models found" }));
    const want = keepModel || store.get(`studio.model.${pid}`, ""); if (want && models.includes(want)) pick.value = want;
  }
  async function refreshChats(selectId) {
    const { chats } = await api(`/api/products/${product.id}/chats`);
    const pick = $("#chatPick");
    pick.replaceChildren(el("option", { value: "", text: chats.length ? "Pick a conversation" : "No conversations yet" }), ...chats.map((c) => el("option", { value: c.id, text: `${c.title} · ${c.model.split("/").pop()}` })));
    if (selectId) pick.value = selectId;
    return chats;
  }
  async function openChat(id) {
    if (!id) { chat.close(); chatId = ""; $("#msgs").append(el("div", { class: "hint" }, el("b", { text: "Pick a provider and model above, then press New chat." }), el("p", { text: "Free options: NVIDIA, OpenRouter (:free models), Groq or Gemini — each needs a free key (Keys button). Ollama runs models on this machine." }))); return; }
    const c = await api(`/api/products/${product.id}/chats/${id}`);
    chatId = id; store.set(`studio.chat.${product.id}`, id); $("#chatPick").value = id;
    $("#providerPick").value = c.provider; await loadModels(c.provider, c.model); $("#modelPick").value = c.model;
    chat.open(c, wsUrl(`/chat?product=${product.id}&chat=${id}`));
  }
  async function newChat() {
    const p = prov(), model = $("#modelPick").value;
    if (!p || !model) { openKeys(p?.id); return; }
    if (p.needsKey && !p.hasKey) { openKeys(p.id); return; }
    const c = await api(`/api/products/${product.id}/chats`, { method: "POST", body: JSON.stringify({ provider: p.id, model }) });
    await refreshChats(c.id); await openChat(c.id); $("#ask").focus();
    // the title is set from the first message; refresh the list after it is sent
    setTimeout(() => refreshChats(chatId).catch(() => {}), 1500);
  }
  $("#btnNewChat").onclick = () => newChat().catch((e) => alert(e.message));
  $("#chatPick").onchange = () => openChat($("#chatPick").value);
  $("#providerPick").onchange = async () => {
    const pid = $("#providerPick").value; store.set("studio.provider", pid);
    const p = cfg.providers.find((x) => x.id === pid);
    if (p.needsKey && !p.hasKey) { openKeys(pid); return; }
    await loadModels(pid); $("#modelPick").onchange();
  };
  $("#modelPick").onchange = async () => {
    store.set(`studio.model.${$("#providerPick").value}`, $("#modelPick").value);
    // Like Cursor: switching model applies to the open conversation from the next message.
    if (chatId && $("#modelPick").value) await api(`/api/products/${product.id}/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ provider: $("#providerPick").value, model: $("#modelPick").value }) }).catch(() => {});
  };
  $("#effortPick").value = store.get("studio.effort", "default");
  $("#effortPick").onchange = () => store.set("studio.effort", $("#effortPick").value);
  $("#composer").onsubmit = async (e) => {
    e.preventDefault(); const text = $("#ask").value.trim(); if (!text) return;
    if (!chatId) { await newChat(); if (!chatId) return; }
    $("#ask").value = "";
    if (!(await chat.send(text, $("#autoApprove").checked, $("#effortPick").value))) $("#ask").value = text;
  };
  $("#ask").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#btnStop").onclick = () => chat.stop();

  // keys dialog
  function openKeys(pid) {
    const sel = $("#kProvider");
    sel.replaceChildren(...cfg.providers.map((p) => el("option", { value: p.id, text: `${p.name}${p.hasKey ? " ✓" : ""}` })));
    sel.value = pid || $("#providerPick").value; keysFill(); $("#dlgKeys").showModal();
  }
  function keysFill() {
    const p = cfg.providers.find((x) => x.id === $("#kProvider").value);
    $("#kHelp").textContent = p.keyHelp; $("#kBaseWrap").hidden = !p.custom; $("#kBase").value = p.base || "";
    $("#kKeyWrap").hidden = !p.needsKey && !p.custom; $("#kKey").value = ""; $("#kKey").placeholder = p.hasKey ? "Key saved. Paste a new one to replace it." : "Paste your key";
    $("#kStatus").textContent = ""; $("#kRemove").hidden = !p.hasKey;
  }
  $("#kProvider").onchange = keysFill;
  $("#btnKeys").onclick = () => openKeys();
  $("#formKeys").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "default") return;
    e.preventDefault(); const id = $("#kProvider").value; $("#kStatus").textContent = "Checking…";
    try {
      const r = await api(`/api/providers/${id}`, { method: "PUT", body: JSON.stringify({ key: $("#kKey").value, base: $("#kBase").value }) });
      cfg = await api("/api/config");
      $("#kStatus").textContent = r.warning ? `Saved, but: ${r.warning}` : `Saved. ${r.models.length} models available.`;
      $("#providerPick").value = id; await loadModels(id); keysFill();
      $("#kStatus").textContent = r.warning ? `Saved, but: ${r.warning}` : `Saved. ${r.models.length} models available.`;
    } catch (err) { $("#kStatus").textContent = err.message; }
  });
  $("#kRemove").onclick = async () => { await api(`/api/providers/${$("#kProvider").value}`, { method: "DELETE" }); cfg = await api("/api/config"); keysFill(); };

  // ---------- model + thinking above the Claude Code / Codex screen ----------
  const EFFORT_NAME = { default: "Default", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  async function loadTermModels() {
    if (engine === "other") return;
    const d = await api(`/api/products/${product.id}/terminal/${engine}`).catch(() => null); if (!d) return;
    $("#tModel").replaceChildren(...d.models.map((m) => el("option", { value: m.id, text: m.name })), ...(d.freeText ? [el("option", { value: "__other", text: "Other model…" })] : []));
    $("#tEffort").replaceChildren(...d.efforts.map((e) => el("option", { value: e, text: EFFORT_NAME[e] || e })));
    const cur = d.current || {};
    const known = d.models.some((m) => m.id === (cur.model || ""));
    $("#tModel").value = known ? cur.model || "" : "__other"; $("#tModelFree").hidden = known; $("#tModelFree").value = known ? "" : cur.model || "";
    $("#tEffort").value = cur.effort || "default"; $("#tNote").textContent = "";
  }
  $("#tModel").onchange = () => { $("#tModelFree").hidden = $("#tModel").value !== "__other"; if (!$("#tModelFree").hidden) $("#tModelFree").focus(); };
  $("#tApply").onclick = async () => {
    const model = $("#tModel").value === "__other" ? $("#tModelFree").value.trim() : $("#tModel").value;
    try {
      await api(`/api/products/${product.id}/terminal/${engine}`, { method: "PUT", body: JSON.stringify({ model, effort: $("#tEffort").value }) });
      $("#tNote").textContent = "Restarted with your choice; your last chat is kept.";
      if (tws?.readyState === 1) { term.reset(); tsend({ t: "restart", mode: "continue" }); } else connectTerm("continue");
    } catch (e) { $("#tNote").textContent = e.message; }
  };

  // ---------- team: which AI each agent uses ----------
  async function loadTeam(body) {
    const t = $("#team");
    try {
      const d = body ? await api(`/api/products/${product.id}/team`, { method: "PUT", body: JSON.stringify(body) }) : await api(`/api/products/${product.id}/team`);
      $("#teamNote").textContent = d.note; $("#teamErr").textContent = d.error || "";
      $("#teamAvail").replaceChildren(el("span", { class: "small muted", text: "AI you have:" }), ...d.models.map((m) => {
        const cb = el("input", { type: "checkbox", "data-id": m.id }); cb.checked = m.available;
        cb.onchange = () => loadTeam({ availability: Object.fromEntries([...document.querySelectorAll("#teamAvail input")].map((x) => [x.dataset.id, x.checked])), overrides: currentOverrides() });
        return el("label", {}, cb, `${m.name}${m.cost === 0 ? "" : m.cost === 2 ? " · pay per use" : ""}`);
      }));
      t.replaceChildren(el("div", { class: "trk head", role: "row" }, el("div", { role: "columnheader", text: "Agent" }), el("div", { role: "columnheader", text: "Uses" }), el("div", { role: "columnheader", text: "Why" })));
      for (const r of d.rows) {
        const sel = el("select", { "data-slug": r.slug, "aria-label": `Model for ${r.name}` }, el("option", { value: "", text: r.pick ? `Auto: ${r.pick.name}` : "Auto (no AI available)" }), ...d.models.filter((m) => m.available).map((m) => el("option", { value: m.id, text: m.name })));
        sel.value = r.overridden ? r.pick?.id || "" : "";
        sel.onchange = () => loadTeam({ overrides: currentOverrides() });
        t.append(el("div", { class: "trk", role: "row" }, el("div", { role: "rowheader" }, el("b", { text: r.name }), el("br"), el("small", { text: r.role })), el("div", { role: "cell" }, sel),
          el("div", { role: "cell" }, el("small", { text: r.why + (r.fallback ? ` Backup: ${r.fallback.name}.` : "") }))));
      }
    } catch (e) { $("#teamErr").textContent = `Team could not load: ${e.message}`; }
  }
  const currentOverrides = () => Object.fromEntries([...document.querySelectorAll("#team select")].map((s) => [s.dataset.slug, s.value]).filter(([, v]) => v));

  // ---------- engine tabs ----------
  function renderEngines() {
    const tabs = [...cfg.terminals.map((t) => ({ id: t.id, name: t.name, sub: "your login" })), { id: "other", name: "Other models", sub: "free or API key" }];
    $("#engines").replaceChildren(...tabs.map((t) => { const b = el("button", { class: "eng", role: "tab", "data-eng": t.id, "aria-selected": String(t.id === engine), title: t.sub }, el("span", { class: "dot" }), t.name); b.onclick = () => pickEngine(t.id); return b; }));
  }
  function pickEngine(id) {
    engine = id; store.set("studio.engine", id);
    document.querySelectorAll(".eng").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.eng === id)));
    const isTerm = id !== "other";
    $("#termPane").hidden = !isTerm; $("#chatPane").hidden = isTerm;
    if (isTerm) { connectTerm(); loadTermModels(); setTimeout(refit, 50); $("#tAsk").placeholder = `Message ${nameOf(id)}… Enter to send · Shift+Enter new line · Ctrl+V or drop files to attach`; }
    else { if (tws) { tws.onclose = null; tws.close(); tws = null; } refreshChats().then(() => openChat(store.get(`studio.chat.${product.id}`, "") && [...$("#chatPick").options].some((o) => o.value === store.get(`studio.chat.${product.id}`)) ? store.get(`studio.chat.${product.id}`) : "")); }
  }

  // ---------- resizable split ----------
  const split = $("#split"), div = $("#divider");
  const setLeft = (pct) => { pct = Math.max(25, Math.min(70, pct)); split.style.setProperty("--left", pct + "%"); store.set("studio.left", String(pct)); };
  setLeft(Number(store.get("studio.left", "42")));
  div.addEventListener("pointerdown", (e) => {
    div.setPointerCapture(e.pointerId);
    document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "none"));
    const move = (ev) => setLeft(((ev.clientX - split.getBoundingClientRect().left) / split.clientWidth) * 100);
    const up = () => { div.removeEventListener("pointermove", move); div.removeEventListener("pointerup", up); document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "")); refit(); };
    div.addEventListener("pointermove", move); div.addEventListener("pointerup", up);
  });
  div.addEventListener("keydown", (e) => { const cur = parseFloat(getComputedStyle(split).getPropertyValue("--left")); if (e.key === "ArrowLeft") setLeft(cur - 3); if (e.key === "ArrowRight") setLeft(cur + 3); refit(); });

  // ---------- right tabs ----------
  let tab = store.get("studio.tab", "");
  function showTab(p) {
    tab = p; store.set("studio.tab", p);
    for (const t of ["app", "proto", "agents"]) { $(`#tab-${t}`).setAttribute("aria-selected", String(t === p)); $(`#pane-${t}`).classList.toggle("show", t === p); }
    const href = p === "app" ? lastAppUrl : p === "proto" ? $("#protoFrame").getAttribute("src") : `https://github.com/${product.repo}/issues?q=is%3Aopen+label%3Aai%3A*`;
    $("#openTab").hidden = !href; if (href) $("#openTab").href = href;
    $("#openTab").textContent = p === "agents" ? "Open on GitHub" : "Open in new tab";
    $("#btnAppLink").hidden = p !== "app";
  }
  document.querySelectorAll(".rtab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.pane)));
  $(".rtabs").addEventListener("keydown", (e) => {
    const order = ["app", "proto", "agents"], i = order.indexOf(tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = order[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; showTab(n); $(`#tab-${n}`).focus(); }
  });
  function setApp(app) {
    const banner = $("#appBanner");
    if (!app || app.kind === "none") { $("#appFrame").hidden = true; $("#appFrame").removeAttribute("src"); $("#appEmpty").hidden = false; banner.hidden = true; lastAppUrl = ""; if (tab === "app") $("#openTab").hidden = true; return; }
    $("#appFrame").hidden = false; $("#appEmpty").hidden = true; banner.hidden = false;
    banner.className = "banner" + (app.kind === "preview" ? " preview" : "");
    banner.replaceChildren(el("b", { text: app.kind === "preview" ? app.label : "Live app" }),
      el("span", { text: app.kind === "preview" ? "Ready to test. Try it here, then tell the AI on the left: approve, or what to change." : "When a feature is ready to test, its preview opens here automatically." }));
    if (app.url !== lastAppUrl) {
      const toPreview = app.kind === "preview" && lastAppUrl !== app.url;
      lastAppUrl = app.url; $("#appFrame").src = app.url;
      if (toPreview && tab !== "app" && board) showTab("app");
    }
    if (tab === "app") { $("#openTab").hidden = false; $("#openTab").href = app.url; }
  }
  // app link dialog
  const openUrl = () => { $("#uUrl").value = product.productionUrl || ""; $("#uErr").textContent = ""; $("#dlgUrl").showModal(); };
  $("#btnAppLink").onclick = openUrl; $("#btnAppLink2").onclick = openUrl;
  $("#formUrl").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "default") return; e.preventDefault();
    try { await api(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ productionUrl: $("#uUrl").value.trim() }) }); $("#dlgUrl").close(); await reloadConfig(product.id); }
    catch (err) { $("#uErr").textContent = err.message; }
  });

  // prototypes
  function renderPrototypes() {
    const pick = $("#protoPick"), list = product.prototypes || [];
    pick.replaceChildren(...list.map((p) => el("option", { value: p, text: p.replace(/\.html$/, "").replace(/[_-]+/g, " ") })));
    $("#protoEmpty").hidden = !!list.length; $("#protoFrame").hidden = !list.length; pick.hidden = !list.length;
    pick.onchange = () => { $("#protoFrame").src = `/proto/${product.id}/${encodeURIComponent(pick.value)}`; if (tab === "proto") $("#openTab").href = $("#protoFrame").getAttribute("src"); };
    if (list.length) pick.onchange(); else $("#protoFrame").removeAttribute("src");
  }
  $("#btnRescan").onclick = async () => { await api(`/api/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ rescan: true }) }); await reloadConfig(product.id); };

  // ---------- agents board ----------
  const KIND = { agent: "an agent is working", founder: "waiting for you", loop: "automatic checks", blocked: "blocked", done: "done", queued: "not started" };
  const initials = (who) => /^(An?|The)\b|AI Org|loop/i.test(who) ? "AI" : /^QA/.test(who) ? "QA" : who.charAt(0).toUpperCase();
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
  function renderBoard(b) {
    board = b;
    const st = $("#boardStatus");
    st.className = "statusline" + (b.error ? " err" : "");
    st.textContent = b.error ? `Agent status could not refresh (${b.error}). Showing what was last loaded at ${new Date(b.updatedAt).toLocaleTimeString()}.` : `Live from GitHub · updated ${new Date(b.updatedAt).toLocaleTimeString()}`;
    $("#noAiOrg").hidden = !!b.aiOrg;
    const run = $("#running"); run.replaceChildren();
    if (!b.working.length) run.append(el("div", { class: "idle", text: b.next ? `No agents working. Next on the backlog: ${b.next.title}.` : "No agents working right now." }));
    for (const w of b.working) {
      const cls = /QA lab/.test(w.who) ? "av qa" : /loop/i.test(w.who) ? "av loop" : "av";
      run.append(el("a", { class: "runner", href: w.url, target: "_blank", rel: "noopener" }, el("span", { class: cls, text: initials(w.who) }),
        el("span", {}, el("b", { text: w.who }), el("small", { text: `${w.what} · ${w.minutes} min` }))));
    }
    const badge = $("#workingBadge"); badge.hidden = !b.working.length; badge.textContent = `${b.working.length} working`;
    $("#waitingWrap").hidden = !b.waiting.length;
    $("#waiting").replaceChildren(...b.waiting.map((r) => el("div", { class: "wait" }, el("b", { text: r.title }),
      el("small", { text: r.stage === "approve" ? "Its Feature Contract is ready. Ask the AI on the left for the 2-minute summary, then approve or request a change." : "Ready for your test. Try it in the Real app tab, then tell the AI: approve, or what to change." }))));
    const t = $("#tracks"); t.replaceChildren();
    t.append(el("div", { class: "trk head", role: "row" }, el("div", { role: "columnheader", text: "Feature" }), ...b.stages.map((s) => el("div", { role: "columnheader", text: s.name }))));
    for (const r of b.rows) {
      const at = b.stages.findIndex((s) => s.id === r.stage);
      const cells = b.stages.map((s, i) => {
        let k = "none";
        if (r.kind === "done") k = "done"; else if (r.kind !== "queued") k = i < at ? "done" : i === at ? r.kind : "none";
        return el("div", { role: "cell", "aria-label": `${s.name}: ${KIND[k] || "not started"}` }, el("div", { class: `st ${k}` }));
      });
      const sub = r.kind === "queued" ? "queued on the backlog" : r.kind === "done" ? "shipped" : `${r.who} · ${KIND[r.kind]}`;
      t.append(el("div", { class: "trk", role: "row" }, el("div", { class: "name", role: "rowheader" }, el("b", { text: r.title }), el("small", { text: sub })), ...cells));
    }
    $("#feed").replaceChildren(...(b.feed.length ? b.feed.map((f) => el("a", { href: f.url, target: "_blank", rel: "noopener" }, el("time", { text: ago(f.at) }), f.text)) : [el("div", { class: "idle", text: "Nothing yet." })]));
    const focus = b.rows.find((r) => r.kind === "founder") || b.rows.find((r) => r.kind === "agent" || r.kind === "loop" || r.kind === "blocked");
    $("#focus").hidden = !focus;
    if (focus) { $("#focusTitle").textContent = focus.title; const p = $("#focusStage"); p.className = `stagepill ${focus.kind}`; p.textContent = focus.kind === "founder" ? "Waiting for your OK" : `${b.stages.find((s) => s.id === focus.stage)?.name || ""}: ${focus.who}`; }
    setApp(b.app);
  }
  async function poll() {
    const pid = product?.id; if (!pid) return;
    try {
      const r = await fetch(`/api/products/${pid}/board`, { cache: "no-store" }); const d = await r.json();
      if (pid !== product.id) return;
      if (r.ok) renderBoard(d);
      else if (board) renderBoard({ ...board, error: d.error || `HTTP ${r.status}` });
      else { const s = $("#boardStatus"); s.className = "statusline err"; s.textContent = `Agent status could not load (${d.error || r.status}). The rest of the Studio keeps working.`; }
    } catch { if (board) renderBoard({ ...board, error: "Studio server not reachable" }); }
  }

  // ---------- products ----------
  function selectProduct(id) {
    product = cfg.products.find((p) => p.id === id) || cfg.products[0];
    store.set("studio.product", product.id); $("#productPick").value = product.id;
    document.title = `${product.name} · AI Org Studio`;
    board = null; lastAppUrl = ""; $("#focus").hidden = true; $("#tracks").replaceChildren(); $("#running").replaceChildren(); $("#feed").replaceChildren(); $("#boardStatus").textContent = "Loading…";
    setApp(product.productionUrl ? { kind: "production", url: product.productionUrl } : { kind: "none" });
    renderPrototypes();
    showTab(tab || (product.productionUrl ? "app" : "proto"));
    pickEngine(engine);
    clearInterval(pollTimer); poll(); pollTimer = setInterval(poll, cfg.boardRefreshMs);
    loadTeam();
  }
  async function reloadConfig(selectId) {
    cfg = await api("/api/config");
    $("#productPick").replaceChildren(...cfg.products.map((p) => el("option", { value: p.id, text: p.name })));
    if (!cfg.products.length) { $("#dlgProduct").showModal(); return; }
    if (product && selectId === product.id) { product = cfg.products.find((p) => p.id === selectId); setApp(product.productionUrl ? { kind: "production", url: product.productionUrl } : { kind: "none" }); renderPrototypes(); poll(); return; }
    selectProduct(selectId || store.get("studio.product", ""));
  }
  $("#productPick").onchange = () => selectProduct($("#productPick").value);
  $("#btnAddProduct").onclick = () => { $("#fErr").textContent = ""; $("#formProduct").reset(); $("#dlgProduct").showModal(); };
  $("#formProduct").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "default") return;
    e.preventDefault(); $("#fErr").textContent = "Copying the repository… this can take a minute."; $("#fAdd").disabled = true;
    try { const r = await api("/api/products", { method: "POST", body: JSON.stringify({ repo: $("#fRepo").value, name: $("#fName").value.trim(), productionUrl: $("#fUrl").value.trim() }) }); $("#dlgProduct").close(); await reloadConfig(r.id); }
    catch (err) { $("#fErr").textContent = err.message; } finally { $("#fAdd").disabled = false; }
  });

  // ---------- start ----------
  (async () => {
    cfg = await api("/api/config");
    $("#where").textContent = `Private to you · ${cfg.platform.name}`;
    renderEngines();
    $("#providerPick").replaceChildren(...cfg.providers.map((p) => el("option", { value: p.id, text: p.name })));
    $("#providerPick").value = store.get("studio.provider", "nvidia");
    if (!$("#providerPick").value) $("#providerPick").value = "nvidia";
    loadModels($("#providerPick").value);
    if (!["claude", "codex", "other"].includes(engine)) engine = "claude";
    await reloadConfig();
  })();
})();
