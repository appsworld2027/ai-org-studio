// Chat view for Claude Code and Codex (structured mode). Looks like the VS Code extension: messages, a live
// "what it's doing" line, compact step cards (read / edit / run), diffs, Allow cards and question cards.
// Model output is rendered with StudioChat.md (DOM nodes only, never innerHTML).
window.EngineChat = (() => {
  "use strict";
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (v != null) e.setAttribute(k, v);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const ICON = { read: "R", edit: "E", run: "›", search: "S", web: "W", plan: "P", agent: "A", ask: "?", tool: "T" };
  const VERB = { read: "Read", edit: "Changed", run: "Ran", search: "Searched", web: "Looked up", plan: "Planned", agent: "Delegated", tool: "Used" };

  function create({ box, statusEl, onBusy, onSend }) {
    let ws = null, cur = null, curText = "", group = null, ready = Promise.resolve(), name = "AI", drawn = false;
    const scroll = () => { if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight; };
    const add = (n) => { box.append(n); scroll(); return n; };
    const setActivity = (text) => {
      statusEl.hidden = !text; statusEl.replaceChildren();
      if (text) statusEl.append(el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: `${text}…` }));
    };

    function userBubble(text, files = []) {
      box.querySelector(".hint")?.remove();
      const b = el("div", { class: "msg me" });
      if (files.length) b.append(el("div", { class: "att" }, ...files.map((f) => el("span", { class: `attchip ${f.image ? "img" : "doc"}`, text: f.name || f.path.split("/").pop().replace(/^\d+-[0-9a-f]+-/, "") }))));
      if (text) b.append(el("div", { class: "txt", text }));
      group = null; return add(b);
    }
    function assistantBubble(text) { const b = el("div", { class: "msg ai" }, el("div", { class: "who", text: name })); if (text) b.append(window.StudioChat.md(text)); group = null; return add(b); }
    // Consecutive steps are grouped under one "Worked on N steps" line, like the IDE extensions.
    function stepGroup() {
      if (group && group.isConnected && box.lastElementChild === group) return group;
      group = add(el("details", { class: "steps", open: "" }, el("summary", {}, el("span", { class: "sum" }))));
      return group;
    }
    function refreshGroup(g) {
      const cards = [...g.querySelectorAll(".step")]; const kinds = {};
      for (const c of cards) kinds[c.dataset.kind] = (kinds[c.dataset.kind] || 0) + 1;
      const parts = Object.entries(kinds).map(([k, n]) => `${VERB[k] || "Used"} ${n} ${k === "read" ? (n > 1 ? "files" : "file") : k === "edit" ? (n > 1 ? "files" : "file") : k === "run" ? (n > 1 ? "commands" : "command") : n > 1 ? "items" : "item"}`);
      g.querySelector(".sum").textContent = parts.join(" · ") || "Working";
    }
    function stepCard(e) {
      const g = stepGroup();
      const head = el("div", { class: "shead" }, el("span", { class: "ico", text: ICON[e.kind] || ICON.tool }), el("span", { class: "stitle", text: e.title }),
        e.detail && e.kind !== "run" && e.kind !== "plan" ? el("span", { class: "sdetail", text: e.detail }) : null, el("span", { class: `sstate ${e.status || "running"}` }));
      const card = el("div", { class: `step ${e.status || "running"}`, "data-id": e.id, "data-kind": e.kind || "tool" }, head);
      if (e.kind === "run" && e.detail) card.append(el("code", { class: "cmd", text: e.detail }));
      if (e.kind === "plan" && e.detail) card.append(el("pre", { class: "plan", text: e.detail }));
      if (e.diff) card.append(diffView(e.diff));
      if (e.result) card.append(resultView(e.result));
      g.append(card); refreshGroup(g); scroll(); return card;
    }
    function diffView(d) {
      const det = el("details", { class: "diff" }, el("summary", { text: "Show changes" }));
      const pre = el("pre");
      const lines = d.patch ? d.patch.split("\n").map((l) => [l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "ctx", l])
        : [...(d.removed ? d.removed.split("\n").map((l) => ["del", `- ${l}`]) : []), ...(d.added ? d.added.split("\n").map((l) => ["add", `+ ${l}`]) : [])];
      for (const [k, l] of lines.slice(0, 400)) pre.append(el("span", { class: k, text: l + "\n" }));
      det.append(pre); return det;
    }
    function resultView(r) { return el("details", { class: "res" }, el("summary", { text: "Output" }), el("pre", { text: r })); }
    function finishStep(e) {
      const card = box.querySelector(`.step[data-id="${CSS.escape(e.id)}"]`); if (!card) return;
      card.classList.remove("running"); card.classList.add(e.ok ? "done" : "failed");
      card.querySelector(".sstate").className = `sstate ${e.ok ? "done" : "failed"}`;
      if (e.diff && !card.querySelector(".diff")) card.append(diffView(e.diff));
      if (e.result && card.dataset.kind === "run") card.append(resultView(e.result));
    }
    function approveCard(e, answered) {
      const card = el("div", { class: "approve", "data-id": e.id, role: "group", "aria-label": "Permission request" },
        el("div", { class: "ahead" }, el("span", { class: "ico", text: ICON[e.kind] || ICON.tool }), el("b", { text: e.kind === "edit" ? `Allow ${name} to change files?` : e.kind === "run" ? `Allow ${name} to run this?` : `Allow ${name} to continue?` })),
        el("div", { class: "atitle", text: e.title }));
      if (e.kind === "run" && e.detail) card.append(el("code", { class: "cmd", text: e.detail }));
      if (e.reason && !/working director/i.test(e.reason)) card.append(el("div", { class: "small muted", text: e.reason }));
      if (e.diff) { const d = diffView(e.diff); d.open = true; card.append(d); }
      const row = el("div", { class: "arow" });
      const yes = el("button", { class: "primary", type: "button", text: "Allow" }), no = el("button", { class: "ghost", type: "button", text: "Don’t allow" });
      yes.onclick = () => { send({ t: "answer", id: e.id, answer: true }); done(true); };
      no.onclick = () => { send({ t: "answer", id: e.id, answer: false }); done(false); };
      const done = (ok) => { row.replaceWith(el("div", { class: `small ${ok ? "ok" : "muted"}`, text: ok ? "Allowed" : "Not allowed" })); card.classList.add("answered"); };
      row.append(yes, no); card.append(row);
      group = null; add(card);
      if (answered != null) done(answered === true || answered === "true"); else yes.focus();
      return card;
    }
    function askCard(e, answered) {
      const card = el("div", { class: "ask", "data-id": e.id, role: "group", "aria-label": "Question" });
      const picks = e.questions.map(() => null);
      e.questions.forEach((q, qi) => {
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
      group = null; add(card);
      if (answered) lock(answered); else card.querySelector(".opt")?.focus();
      return card;
    }

    function handle(e) {
      switch (e.t) {
        case "history": if (!drawn) { render(e.chat); drawn = true; } if (e.busy) { onBusy(true); setActivity("Working"); } break;
        case "user": break;   // already shown when sent (other open tabs see it on reload)
        case "activity": setActivity(e.text); onBusy(true); break;
        case "assistant_start": cur = null; curText = ""; break;
        case "delta": if (!cur) { cur = assistantBubble(""); curText = ""; } curText += e.d; { const old = cur.querySelector(".md"), n = window.StudioChat.md(curText); old ? old.replaceWith(n) : cur.append(n); } setActivity("Writing"); scroll(); break;
        case "tool": cur = null; stepCard(e); break;
        case "tool_done": finishStep(e); break;
        case "approve": cur = null; setActivity(""); approveCard(e); break;
        case "ask": cur = null; setActivity(""); askCard(e); break;
        case "error": setActivity(""); group = null; add(el("div", { class: "msg err", role: "alert", text: e.message })); break;
        case "note": add(el("div", { class: "msg note", text: e.message })); break;
        case "done": case "idle": cur = null; setActivity(""); onBusy(false); break;
        case "session": break;
      }
    }
    function render(chat) {
      box.replaceChildren(); group = null; cur = null;
      if (!chat.events.length) box.append(el("div", { class: "hint" }, el("b", { text: `Chat with ${name} about this product.` }),
        el("p", { text: "Ask it to build a feature, fix a bug, explain how something works, or review the latest changes. It reads the product, shows each step, and asks before it changes anything." })));
      const answers = {}; for (const ev of chat.events) if (ev.t === "answered") answers[ev.id] = ev.answer;
      for (const ev of chat.events) {
        if (ev.t === "user") userBubble(ev.text, ev.files || []);
        else if (ev.t === "assistant") assistantBubble(ev.text);
        else if (ev.t === "tool") stepCard(ev);
        else if (ev.t === "approve") approveCard(ev, ev.id in answers ? answers[ev.id] : false);
        else if (ev.t === "ask") askCard(ev, answers[ev.id] || ["(not answered)"]);
        else if (ev.t === "error") add(el("div", { class: "msg err", text: ev.message }));
      }
      box.scrollTop = box.scrollHeight;
    }
    const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
    return {
      open(url, engineName) {
        name = engineName; drawn = false; if (ws) { ws.onclose = null; ws.close(); }
        box.replaceChildren(); setActivity("");
        ws = new WebSocket(url);
        // Ready = connected AND the saved conversation is drawn (so a new message is never wiped by the history).
        let gotHistory; const history = new Promise((ok) => (gotHistory = ok));
        ready = Promise.race([Promise.all([new Promise((ok) => ws.addEventListener("open", ok, { once: true })), history]), new Promise((ok) => ws.addEventListener("close", ok, { once: true }))]);
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); handle(m); if (m.t === "history") gotHistory(); };
        ws.onclose = () => { onBusy(false); setActivity(""); };
      },
      async send(text, files, opts = {}) {
        await ready;
        if (!ws || ws.readyState !== 1) return false;
        userBubble(text, files); onBusy(true); setActivity("Thinking");
        send({ t: "send", text, files: files.map((f) => ({ path: f.path, name: f.name, image: f.image })), ...opts });
        onSend?.(); return true;
      },
      stop() { send({ t: "stop" }); },
      close() { if (ws) { ws.onclose = null; ws.close(); ws = null; } box.replaceChildren(); setActivity(""); },
    };
  }
  return { create };
})();
