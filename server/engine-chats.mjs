// Studio chats powered by Claude Code or Codex (their official programs in structured mode).
// One running program per conversation, kept alive between messages; transcript saved for reloads.
import { startClaude } from "./engines/claude.mjs";
import { startCodex } from "./engines/codex.mjs";

const KEEP_EVENTS = ["user", "assistant_start", "delta", "tool", "tool_done", "approve", "ask", "answered", "error", "note", "done", "thinking_start", "thinking", "plan", "context", "limits", "mode"];
export const MODES = ["ask", "auto", "plan"];

export function makeEngineChats({ store, env, rulesFor, bins = {}, codexConfig = [], log = () => {}, trustFolder }) {
  const live = new Map(); // `${pid}:${chatId}` -> { engine, clients:Set, busy, chat }

  function broadcast(L, e) { for (const ws of L.clients) if (ws.readyState === 1) ws.send(JSON.stringify(e)); }
  function record(p, L, e) {
    if (!KEEP_EVENTS.includes(e.t)) return;
    const c = L.chat;
    // Collapse streaming text into one transcript entry per assistant message.
    if (e.t === "delta") { const last = c.events.at(-1); if (last?.t === "assistant") { last.text += e.d; return; } c.events.push({ t: "assistant", text: e.d }); return; }
    if (e.t === "assistant_start") return;
    // Thinking text is folded into one entry per thought; plan / usage only keep the latest value.
    if (e.t === "thinking_start") { c.events.push({ t: "thinking", text: "", at: Date.now() }); return; }
    if (e.t === "thinking") { const last = c.events.at(-1); if (last?.t === "thinking") last.text = (last.text + e.d).slice(0, 20000); else c.events.push({ t: "thinking", text: e.d, at: Date.now() }); return; }
    if (e.t === "plan") { c.plan = { steps: e.steps, note: e.note }; const last = c.events.at(-1); if (last?.t === "plan") { Object.assign(last, { steps: e.steps, note: e.note }); return; } }
    if (e.t === "context") { c.context = { used: e.used, window: e.window }; return; }
    if (e.t === "limits") { c.limits = { usedPercent: e.usedPercent, status: e.status || "", resetsAt: e.resetsAt }; return; }
    if (e.t === "tool_done") { const card = [...c.events].reverse().find((x) => x.t === "tool" && x.id === e.id); if (card) Object.assign(card, { status: e.ok ? "done" : "failed", result: e.result, ...(e.diff ? { diff: e.diff } : {}) }); return; }
    c.events.push({ ...e, at: Date.now() });
    if (c.events.length > 2000) c.events.splice(0, c.events.length - 2000);
  }
  function save(p, L) { store.chats.save(p.id, L.chat); }

  function start(p, L) {
    const c = L.chat;
    trustFolder?.(p.dir, c.engine);
    const emit = (e) => {
      if (e.t === "session") { c.sessionId = e.id; if (e.model && !c.modelShown) c.modelShown = e.model; save(p, L); }
      if (e.t === "done" || e.t === "idle") L.busy = false;
      record(p, L, e); broadcast(L, e);
      if (["done", "tool_done", "error", "approve", "ask"].includes(e.t)) save(p, L);
    };
    const common = { cwd: p.dir, env: { ...env, STUDIO: "1" }, model: c.model || "", effort: c.effort || "", mode: c.mode || "ask", rules: rulesFor(p), emit,
      onExit: () => { L.engine = null; L.busy = false; } };
    L.engine = c.engine === "claude"
      ? startClaude({ ...common, bin: bins.claude || "claude", resume: c.sessionId || undefined })
      : startCodex({ ...common, bin: bins.codex || "codex", threadId: c.sessionId || undefined, extraConfig: codexConfig });
    log(`${p.id}: ${c.engine} chat ${c.id} started${c.sessionId ? " (resumed)" : ""}`);
  }

  function get(p, chatId) {
    const key = `${p.id}:${chatId}`; let L = live.get(key);
    if (!L) { const chat = store.chats.get(p.id, chatId); if (!chat) return null; chat.events ||= []; L = { clients: new Set(), busy: false, engine: null, chat }; live.set(key, L); }
    return L;
  }

  return {
    get,
    attach(p, chatId, ws) {
      const L = get(p, chatId); if (!L) return null;
      L.clients.add(ws);
      const c = L.chat;
      ws.send(JSON.stringify({ t: "history", chat: { id: c.id, title: c.title, engine: c.engine, model: c.model, effort: c.effort, mode: c.mode || "ask", plan: c.plan || null, context: c.context || null, limits: c.limits || null, events: c.events }, busy: L.busy }));
      ws.on("close", () => L.clients.delete(ws));
      return L;
    },
    async send(p, chatId, { text, files = [], effort, model, mode }) {
      const L = get(p, chatId); if (!L) throw new Error("Chat not found");
      if (L.busy) throw new Error("Still working on the last message. Press Stop to interrupt.");
      const c = L.chat;
      const settingsChanged = (effort !== undefined && effort !== c.effort) || (model !== undefined && model !== c.model) || (mode !== undefined && mode !== (c.mode || "ask"));
      if (effort !== undefined) c.effort = effort; if (model !== undefined) c.model = model; if (mode !== undefined) c.mode = mode;
      if (settingsChanged && L.engine) { L.engine.stop(); L.engine = null; }   // restart with the new model/effort; the conversation resumes
      if (!L.engine) start(p, L);
      if (c.title === "New chat" && text) c.title = text.replace(/\s+/g, " ").slice(0, 60);
      const ev = { t: "user", text, files: files.map((f) => ({ name: f.name, path: f.path, image: !!f.image })) };
      c.events.push({ ...ev, at: Date.now() }); save(p, L); broadcast(L, ev);
      L.busy = true; c.plan = null; broadcast(L, { t: "activity", text: "Thinking" });
      try { await L.engine.send(text, files, p.dir); }
      catch (e) { L.busy = false; const err = { t: "error", message: e.message }; record(p, L, err); broadcast(L, err); broadcast(L, { t: "idle" }); }
    },
    answer(p, chatId, id, answer) {
      const L = get(p, chatId); if (!L?.engine) return false;
      const ok = L.engine.answer(id, answer);
      if (ok) { const ev = { t: "answered", id, answer }; record(p, L, ev); broadcast(L, ev); save(p, L); }
      return ok;
    },
    interrupt(p, chatId) { const L = get(p, chatId); L?.engine?.interrupt(); },
    stopAll() { for (const L of live.values()) L.engine?.stop(); },
  };
}
