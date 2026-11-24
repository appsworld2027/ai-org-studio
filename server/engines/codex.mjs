// Codex as a chat engine: the official `codex app-server` (JSON-RPC over stdio), OpenAI's documented way for apps to
// drive Codex. Runs with the user's own ChatGPT login (stored by Codex in ~/.codex; the Studio never reads it).
import { spawn } from "node:child_process";
import { describeTool } from "./describe.mjs";

const IMG = /\.(png|jpe?g|gif|webp)$/i;

export function userInput(text, files = [], root = "") {
  const refs = files.filter((f) => !IMG.test(f.path)).map((f) => f.path);
  const input = [];
  const t = [text, refs.length ? `\n\nAttached files (in the project folder): ${refs.join(" ")}` : ""].join("");
  if (t.trim()) input.push({ type: "text", text: t });
  for (const f of files.filter((x) => IMG.test(x.path))) input.push({ type: "localImage", path: `${root}/${f.path}` });
  return input;
}

// Pure translator: one app-server notification → Studio events (unit-tested).
export function translateNotification(m, state) {
  const out = [], p = m.params || {};
  switch (m.method) {
    case "turn/started": state.turnId = p.turn?.id; out.push({ t: "activity", text: "Thinking" }); break;
    case "item/started": {
      const it = p.item || {};
      if (it.type === "agentMessage") out.push({ t: "assistant_start" });
      else if (it.type === "reasoning") out.push({ t: "activity", text: "Thinking" });
      else if (it.type === "commandExecution") { const d = describeTool("commandExecution", { command: it.command }); state.items[it.id] = it; out.push({ t: "tool", id: it.id, kind: d.kind, title: d.title, detail: d.detail, status: "running" }); out.push({ t: "activity", text: d.active }); }
      else if (it.type === "fileChange") { const d = describeTool("fileChange", it); state.items[it.id] = it; out.push({ t: "tool", id: it.id, kind: d.kind, title: d.title, detail: d.detail, diff: d.diff, status: "running" }); out.push({ t: "activity", text: d.active }); }
      else if (it.type === "webSearch") { out.push({ t: "tool", id: it.id, kind: "web", title: `Web search: ${String(it.query || "").slice(0, 80)}`, status: "running" }); out.push({ t: "activity", text: "Searching the web" }); }
      else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") { const d = describeTool(it.tool || it.name || "tool", it.arguments || {}); out.push({ t: "tool", id: it.id, kind: d.kind, title: d.title, status: "running" }); }
      else if (it.type === "plan") out.push({ t: "activity", text: "Planning the steps" });
      break;
    }
    case "item/agentMessage/delta": out.push({ t: "delta", d: p.delta || "" }); break;
    case "item/reasoning/summaryTextDelta": out.push({ t: "activity", text: "Thinking" }); break;
    case "item/completed": {
      const it = p.item || {};
      if (["commandExecution", "fileChange", "webSearch", "mcpToolCall", "dynamicToolCall"].includes(it.type)) {
        const ok = !["failed", "declined"].includes(it.status) && (it.exitCode == null || it.exitCode === 0);
        const extra = it.type === "fileChange" ? { diff: describeTool("fileChange", it).diff } : {};
        out.push({ t: "tool_done", id: it.id, ok, result: String(it.aggregatedOutput || (it.exitCode != null ? `exit ${it.exitCode}` : it.status || "")).slice(0, 4000), ...extra });
      }
      if (it.type === "plan" && it.text) out.push({ t: "tool", id: it.id, kind: "plan", title: "Updated the plan", detail: String(it.text).slice(0, 2000), status: "done" });
      break;
    }
    case "turn/completed": {
      const st = p.turn?.status;
      if (st === "failed") out.push({ t: "error", message: explainError(p.turn?.error?.message || "the turn failed") });
      out.push({ t: "done" }); out.push({ t: "idle" }); break;
    }
    case "error": out.push({ t: "error", message: explainError(p.error?.message || p.message || "") }); break;
    case "account/login/completed": out.push({ t: "login", ok: !!p.success, error: p.error || "" }); break;
  }
  return out;
}
export function explainError(s = "") {
  const t = String(s);
  if (/401|unauthor|not logged|login/i.test(t)) return "Codex is not signed in. Press “Sign in to ChatGPT” above.";
  if (/usage limit|rate limit|429|quota/i.test(t)) return "Your ChatGPT plan's Codex limit is reached for now. Try again later, or switch engines.";
  return `Codex stopped: ${t.slice(0, 300)}`;
}
// Server→client requests (approvals, questions) → Studio cards.
export function translateRequest(m, state) {
  const p = m.params || {};
  if (m.method === "item/commandExecution/requestApproval" || m.method === "execCommandApproval") {
    const d = describeTool("commandExecution", { command: p.command });
    return { t: "approve", id: String(m.id), kind: "run", title: d.title, detail: d.detail, reason: p.reason || "" };
  }
  if (m.method === "item/fileChange/requestApproval" || m.method === "applyPatchApproval") {
    const it = state.items[p.itemId] || {}; const d = describeTool("fileChange", it);
    return { t: "approve", id: String(m.id), kind: "edit", title: d.title, detail: d.detail, diff: d.diff, reason: p.reason || "" };
  }
  if (m.method === "item/tool/requestUserInput") {
    return { t: "ask", id: String(m.id), questions: (p.questions || []).map((q) => ({ id: q.id, question: q.question, header: q.header, multi: false,
      options: (q.options || []).map((o) => ({ label: o.label, detail: o.description || "" })), recommended: (q.options || []).findIndex((o) => /recommended/i.test(`${o.label} ${o.description}`)) })) };
  }
  if (m.method === "item/permissions/requestApproval") return { t: "approve", id: String(m.id), kind: "run", title: "Allow extra access", detail: JSON.stringify(p.permissions || p).slice(0, 300) };
  return null;
}
export function requestResult(method, answer, questions = []) {
  if (method === "item/tool/requestUserInput") { const answers = {}; questions.forEach((q, i) => { answers[q.id] = { answers: [].concat(answer?.[i] ?? []).map(String) }; }); return { answers }; }
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: answer ? "approved" : "denied" };
  if (method === "item/permissions/requestApproval") return answer ? { decision: "accept" } : { decision: "decline" };
  return { decision: answer ? "accept" : "decline" };
}

export function startCodex({ bin = "codex", cwd, env, model, effort, rules, threadId, extraConfig = [], emit, onExit }) {
  const args = ["app-server", ...extraConfig.flatMap((c) => ["-c", c])];
  const p = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const state = { items: {}, turnId: null, threadId: null, pendingReq: {}, stderr: "" };
  let buf = "", n = 0; const waiting = new Map();
  const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  const call = (method, params) => new Promise((ok, fail) => { const id = ++n; waiting.set(id, { ok, fail }); send({ id, method, params }); });
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && m.method) { const e = translateRequest(m, state); if (e) { state.pendingReq[String(m.id)] = { id: m.id, method: m.method, questions: e.questions }; emit(e); } else send({ id: m.id, error: { code: -32601, message: "not supported by AI Org Studio" } }); continue; }
      if (m.id != null && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result); continue; }
      if (m.method) for (const e of translateNotification(m, state)) emit(e);
    }
  });
  p.stderr.on("data", (d) => { state.stderr = (state.stderr + d).slice(-4000); });
  p.on("exit", (code) => { for (const w of waiting.values()) w.fail(new Error("Codex stopped")); emit({ t: "idle" }); onExit?.(state, code); });
  p.on("error", (e) => emit({ t: "error", message: `Could not start Codex: ${e.message}` }));
  const ready = (async () => {
    await call("initialize", { clientInfo: { name: "ai_org_studio", title: "AI Org Studio", version: "2.0.0" } });
    send({ method: "initialized" });
    const account = await call("account/read", {}).catch(() => null);
    return account;
  })();
  const ensureThread = async () => {
    if (state.threadId) return state.threadId;
    const params = { cwd, approvalPolicy: "on-request", developerInstructions: rules || null, ...(model ? { model } : {}) };
    let r;
    if (threadId) { try { r = await call("thread/resume", { threadId, cwd }); } catch { r = null; } }
    if (!r) r = await call("thread/start", params);
    state.threadId = r.thread.id; emit({ t: "session", id: state.threadId, model: r.model || model || "" }); return state.threadId;
  };
  return {
    state, ready,
    async account() { await ready; return call("account/read", {}); },
    async models() { await ready; return call("model/list", {}); },
    async loginDeviceCode() { await ready; return call("account/login/start", { type: "chatgptDeviceCode" }); },
    async send(text, files, root) {
      await ready; const tid = await ensureThread();
      await call("turn/start", { threadId: tid, input: userInput(text, files, root), ...(model ? { model } : {}), ...(effort && effort !== "default" ? { effort } : {}) });
    },
    answer(reqId, answer) { const r = state.pendingReq[reqId]; if (!r) return false; delete state.pendingReq[reqId]; send({ id: r.id, result: requestResult(r.method, answer, r.questions || []) }); return true; },
    interrupt() { if (state.threadId && state.turnId) call("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }).catch(() => {}); },
    stop() { try { p.kill(); } catch { /* gone */ } },
    get alive() { return p.exitCode === null; },
  };
}
