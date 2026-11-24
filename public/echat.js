// Chat view for Claude Code and Codex (structured mode), modelled on the VS Code / Cursor extensions:
// messages with copy, a collapsible "Thought for a moment" block, steps grouped and auto-collapsed into one line
// ("Explored 3 files · Ran 1 command"), live command output, diffs, Allow cards (Allow once / for this chat / Don't),
// question cards, a plan checklist pinned above the composer, and a context meter.
// Model output is rendered with StudioChat.md (DOM nodes only, never innerHTML).
window.EngineChat = (() => {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (v != null) e.setAttribute(k, v);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  // Small line icons (24px grid, drawn with paths so no icon font or network is needed).
  const PATHS = {
    read: "M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6",
    edit: "M4 20h4L19 9l-4-4L4 16z M13 7l4 4",
    run: "M4 5h16v14H4z M7 10l3 2-3 2 M12 15h5",
    search: "M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z M15.5 15.5L20 20",
    web: "M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18",
    plan: "M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2",
    agent: "M12 4a3 3 0 1 1 0 6a3 3 0 0 1 0-6z M5 20c0-4 3-6 7-6s7 2 7 6",
    app: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
    ask: "M9 9a3 3 0 1 1 4 2.8c-.8.4-1 1-1 2.2 M12 18h.01",
    tool: "M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3l8-8a4 4 0 0 0-2-2z",
    think: "M12 3a6 6 0 0 1 4 10.5V16H8v-2.5A6 6 0 0 1 12 3z M9 19h6 M10 21h4",
    copy: "M8 8h11v12H8z M5 16V4h11",
    check: "M5 12l4 4L19 6",
  };
  const icon = (k, cls = "ico") => {
    const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG, "path"); p.setAttribute("d", PATHS[k] || PATHS.tool); s.append(p); return s;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const PHRASE = {
    read: (n) => `Read ${plural(n, "file", "files")}`, search: (n) => (n === 1 ? "Explored the project" : `Explored the project (${n} look-ups)`),
    edit: (n) => `Changed ${plural(n, "file", "files")}`, run: (n) => `Ran ${plural(n, "command", "commands")}`, web: (n) => `${plural(n, "web search", "web searches")}`,
    app: (n) => `Used ${plural(n, "app", "apps")}`, agent: (n) => `${plural(n, "helper agent", "helper agents")}`, plan: () => "Planned", tool: (n) => `Used ${plural(n, "tool", "tools")}`,
  };

  function create({ box, statusEl, planEl, metaEl, onBusy, onSend, onChanges }) {
    let ws = null, cur = null, curText = "", group = null, ready = Promise.resolve(), name = "AI", drawn = false, think = null, thinkText = "", thinkStart = 0, tries = 0, retryT = null, curUrl = "";
    const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 240;
    const scroll = (force) => { if (force || nearBottom()) box.scrollTop = box.scrollHeight; };
    const add = (n) => { const stick = nearBottom(); box.append(n); if (stick) box.scrollTop = box.scrollHeight; return n; };
    const setActivity = (text) => {
      statusEl.hidden = !text; statusEl.replaceChildren();
      if (text) statusEl.append(el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: `${text}…` }));
    };
    const copyBtn = (getText, label = "Copy") => {
      const b = el("button", { type: "button", class: "copy", title: label, "aria-label": label }, icon("copy", "ico sm"));
      b.onclick = async () => { try { await navigator.clipboard.writeText(getText()); b.classList.add("did"); b.replaceChildren(icon("check", "ico sm")); setTimeout(() => { b.classList.remove("did"); b.replaceChildren(icon("copy", "ico sm")); }, 1400); } catch { /* clipboard blocked */ } };
      return b;
    };
    // Every code block in a reply gets its own Copy button.
    const decorate = (mdNode) => { mdNode.querySelectorAll("pre").forEach((pre) => { if (!pre.querySelector(".copy")) pre.append(copyBtn(() => pre.querySelector("code")?.textContent || pre.textContent, "Copy code")); }); return mdNode; };

    function userBubble(text, files = []) {
      box.querySelector(".hint")?.remove(); closeGroup();
      const b = el("div", { class: "msg me" });
      if (files.length) b.append(el("div", { class: "att" }, ...files.map((f) => el("span", { class: `attchip ${f.image ? "img" : "doc"}`, text: f.name || f.path.split("/").pop().replace(/^\d+-[0-9a-f]+-/, "") }))));
      if (text) b.append(el("div", { class: "txt", text }));
      if (text) b.append(el("div", { class: "msgtools" }, copyBtn(() => text, "Copy message")));
      group = null; return add(b);
    }
    function assistantBubble(text) {
      closeGroup();
      const b = el("div", { class: "msg ai" }, el("div", { class: "who", text: name }));
      if (text) b.append(decorate(window.StudioChat.md(text)));
      const tools = el("div", { class: "msgtools" }, copyBtn(() => b.dataset.raw || "", "Copy reply")); b.dataset.raw = text || ""; b.append(tools);
      group = null; return add(b);
    }
    // ---- "Thinking" block (collapsed, like "Thought for 4s" in the extensions) ----
    function thinkingBlock(text, secs) {
      closeGroup();
      const d = el("details", { class: "thinking" }, el("summary", {}, icon("think", "ico sm"), el("span", { class: "tl", text: secs != null ? (secs > 1 ? `Thought for ${secs}s` : "Thought for a moment") : "Thinking" })), el("div", { class: "tbody" }));
      if (text) d.querySelector(".tbody").textContent = text.trim();
      group = null; return add(d);
    }
    // ---- grouped steps ----
    function stepGroup() {
      if (group && group.isConnected && box.lastElementChild === group) return group;
      group = add(el("details", { class: "steps", open: "" }, el("summary", {}, el("span", { class: "sum" }), el("span", { class: "gstate" }))));
      return group;
    }
    function refreshGroup(g) {
      const cards = [...g.querySelectorAll(":scope > .step")]; const kinds = {};
      for (const c of cards) kinds[c.dataset.kind] = (kinds[c.dataset.kind] || 0) + 1;
      g.querySelector(".sum").textContent = Object.entries(kinds).map(([k, n]) => (PHRASE[k] || PHRASE.tool)(n)).join(" · ") || "Working";
      const running = g.querySelector(".step.running"), failed = g.querySelector(".step.failed");
      g.querySelector(".gstate").className = `gstate ${running ? "running" : failed ? "failed" : "done"}`;
    }
    // A finished group folds into its one-line summary (open it to see each step), like Cursor's "Explored 3 files".
    function closeGroup() { if (group && group.isConnected && !group.querySelector(".step.running") && !group.dataset.keepOpen) group.open = false; }
    function stepCard(e) {
      const g = stepGroup();
      const head = el("div", { class: "shead" }, icon(e.kind || "tool"), el("span", { class: "stitle", text: e.title }),
        e.detail && !["run", "plan"].includes(e.kind) ? el("span", { class: "sdetail", text: e.detail }) : null, el("span", { class: `sstate ${e.status || "running"}` }));
      const card = el("div", { class: `step ${e.status || "running"}`, "data-id": e.id, "data-kind": e.kind || "tool" }, head);
      const cmd = e.cmd || (e.kind === "run" ? e.detail : "");
      if (cmd) card.append(el("details", { class: "cmdbox" }, el("summary", { text: "Command" }), el("code", { class: "cmd", text: cmd })));
      if (e.kind === "plan" && e.detail) card.append(el("pre", { class: "plan", text: e.detail }));
      if (e.diff) card.append(diffView(e.diff));
      if (e.result) card.append(resultView(e.result, e.kind));
      g.append(card); refreshGroup(g); scroll(); return card;
    }
    function diffView(d) {
      const det = el("details", { class: "diff" }, el("summary", { text: "Show changes" }));
      const pre = el("pre");
      const lines = d.patch ? d.patch.split("\n").filter((l) => !/^(diff --git|index |@@ -0,0)/.test(l)).map((l) => [l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx", l])
        : [...(d.removed ? d.removed.split("\n").map((l) => ["del", `- ${l}`]) : []), ...(d.added ? d.added.split("\n").map((l) => ["add", `+ ${l}`]) : [])];
      for (const [k, l] of lines.slice(0, 600)) pre.append(el("span", { class: k, text: l + "\n" }));
      det.append(pre); return det;
    }
    function resultView(r, kind) {
      const lines = String(r).split("\n").length;
      return el("details", { class: "res" }, el("summary", { text: kind === "run" ? `Output · ${plural(lines, "line", "lines")}` : "Result" }), el("pre", { text: r }));
    }
    function finishStep(e) {
      const card = box.querySelector(`.step[data-id="${CSS.escape(e.id)}"]`); if (!card) return;
      card.classList.remove("running"); card.classList.add(e.ok ? "done" : "failed");
      card.querySelector(".sstate").className = `sstate ${e.ok ? "done" : "failed"}`;
      if (e.title) card.querySelector(".stitle").textContent = e.title;
      if (e.diff && !card.querySelector(".diff")) card.append(diffView(e.diff));
      if (e.result && !card.querySelector(".res") && !["edit"].includes(card.dataset.kind)) { const r = resultView(e.result, card.dataset.kind); if (!e.ok) r.open = true; card.append(r); }
      const g = card.closest(".steps"); if (g) { refreshGroup(g); if (!e.ok) g.dataset.keepOpen = "1"; }
      if (card.dataset.kind === "edit") onChanges?.();
    }
    function approveCard(e, answered) {
      const isPlan = e.kind === "plan";
      const head = isPlan ? `${name} has a plan` : e.kind === "edit" ? `Allow ${name} to change files?` : e.kind === "run" ? `Allow ${name} to run this?` : `Allow ${name} to continue?`;
      const card = el("div", { class: `approve${isPlan ? " planapprove" : ""}`, "data-id": e.id, role: "group", "aria-label": isPlan ? "Plan" : "Permission request" },
        el("div", { class: "ahead" }, icon(e.kind || "tool"), el("b", { text: head })), isPlan ? null : el("div", { class: "atitle", text: e.title }));
      if (isPlan && e.plan) card.append(decorate(window.StudioChat.md(e.plan)));
      if (e.kind === "run" && e.detail) card.append(el("code", { class: "cmd", text: e.detail }));
      if (e.reason && !/working director/i.test(e.reason)) card.append(el("div", { class: "small muted", text: e.reason }));
      if (e.diff) { const d = diffView(e.diff); d.open = true; card.append(d); }
      const row = el("div", { class: "arow" });
      const yes = el("button", { class: "primary", type: "button", text: isPlan ? "Go ahead" : "Allow" });
      const always = isPlan ? null : el("button", { class: "ghost", type: "button", text: e.kind === "edit" ? "Allow all edits in this chat" : "Allow for this chat", title: e.kind === "edit" ? "Stop asking about file changes for the rest of this chat" : "Stop asking about this kind of command for the rest of this chat" });
      const no = el("button", { class: "ghost", type: "button", text: isPlan ? "Keep planning" : "Don’t allow" });
      const done = (ans) => { row.replaceWith(el("div", { class: `small ${ans ? "ok" : "muted"}`, text: isPlan ? (ans ? "Going ahead" : "Kept planning") : ans === "session" ? "Allowed for this chat" : ans ? "Allowed" : "Not allowed" })); card.classList.add("answered"); };
      yes.onclick = () => { send({ t: "answer", id: e.id, answer: true }); done(true); };
      if (always) always.onclick = () => { send({ t: "answer", id: e.id, answer: "session" }); done("session"); };
      no.onclick = () => { send({ t: "answer", id: e.id, answer: false }); done(false); };
      row.append(yes, always, no); card.append(row);
      closeGroup(); group = null; add(card);
      if (answered != null) done(answered === "session" ? "session" : answered === true || answered === "true"); else yes.focus({ preventScroll: true });
      return card;
    }
    function askCard(e, answered) {
      const card = el("div", { class: "ask", "data-id": e.id, role: "group", "aria-label": "Question" });
      const picks = e.questions.map(() => null);
      e.questions.forEach((q, qi) => {
        if (q.header) card.append(el("div", { class: "qh", text: q.header }));
        card.append(el("div", { class: "q", text: q.question }));
        const opts = el("div", { class: "opts" });
        q.options.forEach((o, i) => {
          const shown = String(o.label).replace(/\s*\(recommended\)\s*/i, " ").trim();
          const b = el("button", { type: "button", class: "opt", "data-label": o.label }, el("b", { text: shown }), i === q.recommended ? el("span", { class: "rec", text: "Recommended" }) : null, o.detail ? el("small", { text: o.detail.replace(/\s*\(recommended\)\s*/i, " ").trim() }) : null);
          b.onclick = () => { if (card.classList.contains("done")) return; picks[qi] = o.label; opts.querySelectorAll(".opt").forEach((x) => x.classList.toggle("chosen", x === b)); maybeSend(); };
          opts.append(b);
        });
        const inp = el("input", { placeholder: "Or type your own answer", "aria-label": "Your own answer" });
        inp.onkeydown = (ev) => { if (ev.key === "Enter" && inp.value.trim()) { ev.preventDefault(); picks[qi] = inp.value.trim(); maybeSend(); } };
        card.append(opts, el("div", { class: "other" }, inp));
      });
      const maybeSend = () => { if (picks.every((x) => x)) { send({ t: "answer", id: e.id, answer: picks }); lock(picks); } };
      const lock = (ans) => { card.classList.add("done"); card.querySelectorAll("button,input").forEach((x) => (x.disabled = true)); [].concat(ans).forEach((a) => card.querySelector(`.opt[data-label="${CSS.escape(String(a))}"]`)?.classList.add("chosen")); };
      closeGroup(); group = null; add(card);
      if (answered) lock(answered); else card.querySelector(".opt")?.focus({ preventScroll: true });
      return card;
    }
    // ---- plan checklist pinned above the composer (TodoWrite / Codex plan updates) ----
    function showPlan(p) {
      if (!planEl) return;
      if (!p || !p.steps?.length) { planEl.hidden = true; planEl.replaceChildren(); return; }
      const doneN = p.steps.filter((s) => s.status === "completed").length;
      const allDone = doneN === p.steps.length, prev = planEl.querySelector("details");
      const wasOpen = allDone ? false : prev ? prev.open || prev.dataset.done === "1" : true;
      const list = el("ol", { class: "planlist" }, ...p.steps.map((s) => el("li", { class: s.status || "pending" }, el("span", { class: "pmark", "aria-hidden": "true" }), el("span", { text: s.text }))));
      const d = el("details", wasOpen ? { open: "" } : {}, el("summary", {}, icon("plan", "ico sm"), el("b", { text: "Plan" }), el("span", { class: "muted", text: ` ${doneN} of ${p.steps.length} done` })), list);
      d.dataset.done = allDone ? "1" : ""; planEl.replaceChildren(d); planEl.hidden = false;
    }
    // ---- context meter + plan limits ----
    let meta = { context: null, limits: null };
    function showMeta() {
      if (!metaEl) return;
      const parts = [];
      const c = meta.context;
      if (c?.used && c?.window && c.used / c.window >= 0.01) { const pct = Math.min(100, Math.round((c.used / c.window) * 100)); parts.push(el("span", { class: `ctx ${pct > 80 ? "hi" : ""}`, title: `Conversation memory: ${pct}% used (${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens). Near 100% the AI summarises older messages; start a New chat for a fresh topic.`, "aria-label": `${pct}% memory used` }, el("i", { style: `--p:${pct}%` }), `${pct}%`)); }
      const l = meta.limits;
      if (l?.usedPercent != null && l.usedPercent >= 50) parts.push(el("span", { class: `lim ${l.usedPercent > 80 ? "hi" : ""}`, title: "How much of your plan's current usage window is used" }, `Plan ${l.usedPercent}% used`));
      else if (l?.status && l.status !== "allowed") parts.push(el("span", { class: "lim hi" }, "Plan limit nearly reached"));
      metaEl.replaceChildren(...parts); metaEl.hidden = !parts.length;
    }

    function handle(e) {
      switch (e.t) {
        case "history": if (!drawn) { render(e.chat); drawn = true; statusEl.classList.remove("offline"); } if (e.busy) { onBusy(true); setActivity("Working"); } break;
        case "user": break;   // already shown when sent (other open tabs see it on reload)
        case "activity": setActivity(e.text); onBusy(true); break;
        case "thinking_start": think = thinkingBlock("", null); think.classList.add("live"); thinkText = ""; thinkStart = Date.now(); break;
        case "thinking": if (!think) { think = thinkingBlock("", null); think.classList.add("live"); thinkText = ""; thinkStart = Date.now(); } thinkText += e.d; think.querySelector(".tbody").textContent = thinkText.trim(); break;
        case "thinking_end": if (think) { const s = Math.round((Date.now() - thinkStart) / 1000); think.classList.remove("live"); think.querySelector(".tl").textContent = s > 1 ? `Thought for ${s}s` : "Thought for a moment"; if (!thinkText.trim()) think.remove(); think = null; } break;
        case "assistant_start": cur = null; curText = ""; break;
        case "delta": if (!cur) { cur = assistantBubble(""); curText = ""; } curText += e.d; cur.dataset.raw = curText;
          { const old = cur.querySelector(".md"), n = decorate(window.StudioChat.md(curText)); old ? old.replaceWith(n) : cur.insertBefore(n, cur.querySelector(".msgtools")); } setActivity("Writing"); scroll(); break;
        case "tool": cur = null; if (think) handle({ t: "thinking_end" }); stepCard(e); break;
        case "tool_done": finishStep(e); break;
        case "approve": cur = null; setActivity(""); approveCard(e); break;
        case "ask": cur = null; setActivity(""); askCard(e); break;
        case "plan": showPlan(e); break;
        case "context": meta.context = { used: e.used, window: e.window }; showMeta(); break;
        case "limits": meta.limits = e; showMeta(); break;
        case "error": setActivity(""); closeGroup(); group = null; add(el("div", { class: "msg err", role: "alert", text: e.message })); break;
        case "note": add(el("div", { class: "msg note", text: e.message })); break;
        case "done": case "idle": cur = null; if (think) handle({ t: "thinking_end" }); closeGroup(); setActivity(""); onBusy(false); onChanges?.(); planEl?.classList.add("idle"); break;
        case "session": break;
      }
    }
    function render(chat) {
      box.replaceChildren(); group = null; cur = null; think = null;
      if (!chat.events.length) box.append(el("div", { class: "hint" }, el("b", { text: `Chat with ${name} about this product.` }),
        el("p", { text: "Ask it to build a feature, fix a bug, explain how something works, or review the latest changes. It reads the product, shows each step, and asks before it changes anything." }),
        el("p", { class: "small muted", text: "Tip: type @ to point it at a file. Paste a screenshot with Ctrl+V." })));
      const answers = {}; for (const ev of chat.events) if (ev.t === "answered") answers[ev.id] = ev.answer;
      for (const ev of chat.events) {
        if (ev.t === "user") userBubble(ev.text, ev.files || []);
        else if (ev.t === "assistant") assistantBubble(ev.text);
        else if (ev.t === "thinking") { if (ev.text?.trim()) thinkingBlock(ev.text, 0); }
        else if (ev.t === "tool") stepCard(ev);
        else if (ev.t === "approve") approveCard(ev, ev.id in answers ? answers[ev.id] : false);
        else if (ev.t === "ask") askCard(ev, answers[ev.id] || ["(not answered)"]);
        else if (ev.t === "error") add(el("div", { class: "msg err", text: ev.message }));
      }
      closeGroup();
      showPlan(chat.plan); meta = { context: chat.context, limits: chat.limits }; showMeta();
      box.scrollTop = box.scrollHeight;
    }
    const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
    return {
      open(url, engineName, reconnecting = false) {
        name = engineName; if (ws) { ws.onclose = null; ws.close(); }
        // A reconnect redraws from the saved conversation (the server keeps working while you are away).
        drawn = false; clearTimeout(retryT);
        if (!reconnecting) { tries = 0; box.replaceChildren(); setActivity(""); showPlan(null); meta = { context: null, limits: null }; showMeta(); }
        curUrl = url;
        ws = new WebSocket(url);
        // Ready = connected AND the saved conversation is drawn (so a new message is never wiped by the history).
        let gotHistory; const history = new Promise((ok) => (gotHistory = ok));
        ready = Promise.race([Promise.all([new Promise((ok) => ws.addEventListener("open", ok, { once: true })), history]), new Promise((ok) => ws.addEventListener("close", ok, { once: true }))]);
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); handle(m); if (m.t === "history") gotHistory(); };
        ws.onopen = () => { tries = 0; statusEl.classList.remove("offline"); };
        ws.onclose = () => {
          onBusy(false); setActivity("");
          // Lost the connection (laptop slept, tunnel restarted, phone switched network): try again, quietly.
          const wait = Math.min(15000, 1000 * 2 ** Math.min(tries++, 4));
          statusEl.hidden = false; statusEl.classList.add("offline"); statusEl.replaceChildren(el("span", { text: `Connection lost — reconnecting in ${Math.round(wait / 1000)}s…` }));
          retryT = setTimeout(() => this.open(curUrl, name, true), wait);
        };
      },
      async send(text, files, opts = {}) {
        await ready;
        if (!ws || ws.readyState !== 1) return false;
        userBubble(text, files); scroll(true); onBusy(true); setActivity("Thinking"); showPlan(null); planEl?.classList.remove("idle");
        send({ t: "send", text, files: files.map((f) => ({ path: f.path, name: f.name, image: f.image })), ...opts });
        onSend?.(); return true;
      },
      stop() { send({ t: "stop" }); },
      // For the browser test: drop the connection like a network change would (keeps the reconnect logic in play).
      dropConnection() { if (!ws) return false; ws.close(); return true; },
      close() { clearTimeout(retryT); if (ws) { ws.onclose = null; ws.close(); ws = null; } box.replaceChildren(); setActivity(""); showPlan(null); meta = { context: null, limits: null }; showMeta(); },
    };
  }
  return { create, icon };
})();
