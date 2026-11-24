// Studio-drawn chat for "Other models". Renders model text safely (no innerHTML of model output).
window.StudioChat = (() => {
  "use strict";
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  // Minimal, safe markdown: paragraphs, **bold**, `code`, ```blocks```, lists, links (https only). Builds DOM nodes only.
  function md(text) {
    const root = el("div", { class: "md" });
    const blocks = String(text || "").split(/```/);
    blocks.forEach((b, i) => {
      if (i % 2) { const nl = b.indexOf("\n"); root.append(el("pre", {}, el("code", { text: nl >= 0 ? b.slice(nl + 1) : b }))); return; }
      let list = null;
      for (const raw of b.split("\n")) {
        const line = raw.trimEnd();
        const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
        if (li) { if (!list) { list = el(/^\s*\d/.test(line) ? "ol" : "ul"); root.append(list); } list.append(inline(el("li"), li[1])); continue; }
        list = null;
        if (!line.trim()) continue;
        const h = line.match(/^#{1,4}\s+(.*)$/);
        root.append(inline(el(h ? "h4" : "p"), h ? h[1] : line));
      }
    });
    return root;
  }
  function inline(node, s) {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\)|https:\/\/[^\s)]+)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) node.append(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith("**")) node.append(el("b", { text: t.slice(2, -2) }));
      else if (t.startsWith("`")) node.append(el("code", { text: t.slice(1, -1) }));
      else if (t.startsWith("[")) { const mm = t.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/); node.append(el("a", { href: mm[2], target: "_blank", rel: "noopener", text: mm[1] })); }
      else node.append(el("a", { href: t, target: "_blank", rel: "noopener", text: t }));
      last = m.index + t.length;
    }
    if (last < s.length) node.append(s.slice(last));
    return node;
  }
  const TOOL_LABEL = { list_files: "Looked at files", read_file: "Read", search: "Searched", write_file: "Wants to write", edit_file: "Wants to edit", run_command: "Wants to run" };
  const DONE_LABEL = { write_file: "Wrote", edit_file: "Edited", run_command: "Ran" };
  const appLabel = (name) => { const m = String(name).match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/); return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)}: ${m[2].replace(/_/g, " ")}` : null; };
  function toolSummary(name, args) {
    if (appLabel(name)) return Object.values(args || {}).map(String).join(" · ").slice(0, 80);
    if (name === "run_command") return args.command;
    if (name === "search") return `“${args.pattern}”${args.path ? ` in ${args.path}` : ""}`;
    return args.path || ".";
  }

  function create({ box, onBusy }) {
    let ws = null, assistantEl = null, assistantText = "";
    const scroll = () => { box.scrollTop = box.scrollHeight; };
    const add = (n) => { box.append(n); scroll(); return n; };
    function bubble(role, text) {
      if (role === "user") return add(el("div", { class: "msg me" }, el("div", { class: "who", text: "You" }), el("div", { class: "txt", text })));
      const b = add(el("div", { class: "msg ai" }, el("div", { class: "who", text: "AI" })));
      if (text) b.append(md(text));
      return b;
    }
    function toolCard(id, name, args, ask, result) {
      const card = el("div", { class: "toolcard" + (ask ? " ask" : ""), "data-id": id },
        el("div", { class: "tline" }, el("b", { text: (result != null && DONE_LABEL[name]) || TOOL_LABEL[name] || appLabel(name) || name }), " ", el("code", { text: toolSummary(name, args) })));
      if (name === "write_file" || name === "edit_file") {
        const d = el("details", {}, el("summary", { text: "Show the change" }));
        if (name === "edit_file") d.append(el("pre", { class: "diff" }, el("span", { class: "del", text: args.old_text }), "\n", el("span", { class: "add", text: args.new_text })));
        else d.append(el("pre", {}, el("code", { text: String(args.content).slice(0, 6000) })));
        card.append(d);
      }
      if (result != null) card.append(el("details", {}, el("summary", { text: "Result" }), el("pre", {}, el("code", { text: result }))));
      return card;
    }
    function askCard(q, answer) {
      const card = el("div", { class: "ask" + (answer ? " done" : ""), "data-id": q.id, role: "group", "aria-label": q.question }, el("div", { class: "q", text: q.question }));
      const opts = el("div", { class: "opts" });
      const choose = (text) => {
        if (card.classList.contains("done")) return;
        ws?.send(JSON.stringify({ t: "answer", id: q.id, answer: text }));
        markAnswered(card, text);
      };
      q.options.forEach((o, i) => {
        const b = el("button", { type: "button", class: "opt", "data-label": o.label }, el("b", { text: o.label }), i === q.recommended ? el("span", { class: "rec", text: "Recommended" }) : null, o.detail ? el("small", { text: o.detail }) : null);
        b.onclick = () => choose(o.label + (i === q.recommended ? " (the recommended option)" : ""));
        opts.append(b);
      });
      card.append(opts);
      const inp = el("input", { placeholder: "Or type your own answer", "aria-label": "Your own answer" }), go = el("button", { type: "button", class: "ghost small", text: "Send" });
      go.onclick = () => inp.value.trim() && choose(inp.value.trim()); inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } };
      card.append(el("div", { class: "other" }, inp, go));
      if (answer) markAnswered(card, answer);
      return card;
    }
    function markAnswered(card, text) {
      card.classList.add("done");
      card.querySelectorAll("button,input").forEach((x) => (x.disabled = true));
      const hit = [...card.querySelectorAll(".opt")].find((b) => text.startsWith(b.dataset.label));
      if (hit) hit.classList.add("chosen"); else card.append(el("div", { class: "small", text: `You answered: ${text}` }));
    }
    function render(chat) {
      box.replaceChildren();
      if (!chat.messages.length) box.append(el("div", { class: "hint" }, el("b", { text: "Start with what you want." }), el("p", { text: "For example: “What is next on the backlog?”, “Add dark mode to the settings screen”, or “Why did the last test run fail?”. The AI reads the product, proposes options, and asks before it changes anything." })));
      const results = {};
      for (const m of chat.messages) if (m.role === "tool") results[m.tool_call_id] = m.content;
      for (const m of chat.messages) {
        if (m.role === "user") bubble("user", m.content);
        else if (m.role === "assistant") {
          if (m.content) bubble("assistant", m.content);
          for (const tc of m.tool_calls || []) {
            let a = {}; try { a = JSON.parse(tc.function.arguments); } catch { /* shown raw */ }
            if (tc.function.name === "ask_user" && Array.isArray(a.options)) {
              const ans = (results[tc.id] || "").replace(/^The product owner chose: /, "");
              add(askCard({ id: tc.id, question: a.question, options: a.options.map((o) => (typeof o === "string" ? { label: o } : o)), recommended: a.recommended | 0 }, results[tc.id] ? ans : null));
            } else add(toolCard(tc.id, tc.function.name, a, false, results[tc.id] ?? ""));
          }
        }
      }
      scroll();
    }
    let ready = Promise.resolve();
    function connect(url) {
      if (ws) { ws.onclose = null; ws.close(); }
      ws = new WebSocket(url);
      ready = new Promise((ok) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("close", ok, { once: true }); });
      ws.onmessage = (e) => handle(JSON.parse(e.data));
      ws.onclose = () => onBusy(false);
    }
    function handle(e) {
      if (e.t === "busy") onBusy(true);
      if (e.t === "assistant_start") { assistantEl = null; assistantText = ""; onBusy(true); }
      if (e.t === "delta") {
        if (!assistantEl) assistantEl = bubble("assistant", "");
        assistantText += e.d; const old = assistantEl.querySelector(".md"); const n = md(assistantText); old ? old.replaceWith(n) : assistantEl.append(n); scroll();
      }
      if (e.t === "tool") {
        assistantEl = null; assistantText = "";
        const card = add(toolCard(e.id, e.name, e.args, e.ask));
        if (e.ask) {
          const row = el("div", { class: "row" }, el("span", { class: "small muted", text: "Allow this?" }));
          const yes = el("button", { class: "primary small", type: "button", text: "Allow" }), no = el("button", { class: "ghost small", type: "button", text: "Don’t allow" });
          yes.onclick = () => { ws.send(JSON.stringify({ t: "approve", id: e.id })); row.replaceWith(el("div", { class: "small ok", text: "Allowed" })); };
          no.onclick = () => { ws.send(JSON.stringify({ t: "deny", id: e.id })); row.replaceWith(el("div", { class: "small muted", text: "Not allowed" })); };
          row.append(yes, no); card.append(row); yes.focus();
        }
      }
      if (e.t === "ask") { assistantEl = null; assistantText = ""; const c = add(askCard(e)); c.querySelector(".opt")?.focus(); }
      if (e.t === "note") add(el("div", { class: "msg note", text: e.message }));
      if (e.t === "tool_result") { const card = box.querySelector(`.toolcard[data-id="${CSS.escape(e.id)}"]`); if (card) { card.classList.remove("ask"); card.append(el("details", {}, el("summary", { text: "Result" }), el("pre", {}, el("code", { text: e.result })))); } }
      if (e.t === "error") add(el("div", { class: "msg err", role: "alert", text: e.message }));
      if (e.t === "stopped") add(el("div", { class: "small muted", text: "Stopped." }));
      if (e.t === "idle" || e.t === "done") { if (e.t === "idle") onBusy(false); }
    }
    return {
      open(chat, url) { render(chat); connect(url); },
      async send(text, auto, effort) {
        await ready;
        if (!ws || ws.readyState !== 1) { add(el("div", { class: "msg err", role: "alert", text: "Not connected to the Studio. Reload the page and try again." })); return false; }
        bubble("user", text); ws.send(JSON.stringify({ t: "send", text, auto, effort })); onBusy(true); return true;
      },
      stop() { ws?.send(JSON.stringify({ t: "stop" })); },
      close() { if (ws) { ws.onclose = null; ws.close(); ws = null; } box.replaceChildren(); },
    };
  }
  return { create, md };
})();
