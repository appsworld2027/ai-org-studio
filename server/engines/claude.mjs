// Claude Code as a chat engine: the official `claude` program in its structured mode
// (`-p --input-format stream-json --output-format stream-json`, the same channel the VS Code extension and Zed use).
// It runs with the user's own Claude login (personal use; see docs/COMPLIANCE.md). The Studio never reads or stores tokens.
// Emits Studio chat events: text, activity, tool cards, approval and question requests, usage, done.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describeTool } from "./describe.mjs";

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Studio work modes → Claude Code permission modes. Ask first = Claude's default (reads free, edits and commands ask).
export const CLAUDE_MODES = { auto: "acceptEdits", plan: "plan" };
export function claudeArgs({ model, effort, resume, rules, mode }) {
  const a = ["-p", ...(CLAUDE_MODES[mode] ? ["--permission-mode", CLAUDE_MODES[mode]] : []), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompt-tool", "stdio", "--append-system-prompt", rules || ""];
  if (model) a.push("--model", model);
  if (effort && effort !== "default") a.push("--effort", effort);
  if (resume) a.push("--resume", resume);
  return a;
}

// Turns attachments into Claude content blocks: images inline, everything else by path (Claude reads it with its tools).
export function userContent(text, files = [], root = "") {
  const content = [];
  const refs = files.filter((f) => !IMG.test(f.path)).map((f) => `@${f.path}`);
  const t = [text, refs.length ? `\n\nAttached files: ${refs.join(" ")}` : ""].join("");
  if (t.trim()) content.push({ type: "text", text: t });
  for (const f of files.filter((x) => IMG.test(x.path))) {
    try { content.push({ type: "image", source: { type: "base64", media_type: MIME[f.path.split(".").pop().toLowerCase()], data: readFileSync(`${root}/${f.path}`).toString("base64") } }); }
    catch { content.push({ type: "text", text: `(Image ${f.path} could not be read.)` }); }
  }
  return content;
}

// Pure translator: one stream-json message in → Studio events out (unit-tested).
export function translate(m, state) {
  const out = [];
  if (m.type === "system" && m.subtype === "init") { state.sessionId = m.session_id; state.model = m.model; out.push({ t: "session", id: m.session_id, model: m.model }); }
  else if (m.type === "system" && m.subtype === "status" && m.status === "requesting") out.push({ t: "activity", text: "Thinking" });
  else if (m.type === "stream_event") {
    const e = m.event;
    if (e.type === "content_block_start" && e.content_block?.type === "text") out.push({ t: "assistant_start" });
    if (e.type === "content_block_start" && e.content_block?.type === "thinking") { out.push({ t: "thinking_start" }); out.push({ t: "activity", text: "Thinking" }); }
    if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") out.push({ t: "thinking", d: e.delta.thinking || "" });
    if (e.type === "content_block_stop" && state.lastBlock === "thinking") out.push({ t: "thinking_end" });
    if (e.type === "content_block_start") state.lastBlock = e.content_block?.type;
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") out.push({ t: "delta", d: e.delta.text });
    if (e.type === "content_block_start" && e.content_block?.type === "tool_use") out.push({ t: "activity", text: describeTool(e.content_block.name, {}).active });
  } else if (m.type === "assistant") {
    const u = m.message?.usage;
    if (u && !m.parent_tool_use_id) out.push({ t: "context", used: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), window: /\[1m\]/.test(state.model || "") ? 1000000 : 200000 });
    for (const b of m.message?.content || []) if (b.type === "tool_use" && b.name === "TodoWrite")
      out.push({ t: "plan", steps: (b.input?.todos || []).map((x) => ({ text: x.content, status: x.status })), note: "" });
    for (const b of m.message?.content || []) if (b.type === "tool_use" && !["AskUserQuestion", "TodoWrite", "ExitPlanMode"].includes(b.name)) {
      const d = describeTool(b.name, b.input);
      state.tools[b.id] = { name: b.name, input: b.input };
      out.push({ t: "tool", id: b.id, kind: d.kind, title: d.title, detail: d.detail, status: "running", diff: d.diff });
    }
  } else if (m.type === "user") {
    for (const b of m.message?.content || []) if (b.type === "tool_result" && state.tools[b.tool_use_id]) {
      const txt = typeof b.content === "string" ? b.content : (b.content || []).map((c) => c.text || "").join("\n");
      out.push({ t: "tool_done", id: b.tool_use_id, ok: !b.is_error, result: txt.slice(0, 4000) });
    }
  } else if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
    const r = m.request;
    if (r.tool_name === "AskUserQuestion") {
      out.push({ t: "ask", id: m.request_id, questions: (r.input?.questions || []).map((q, i) => ({ id: String(i), question: q.question, header: q.header, multi: !!q.multiSelect,
        options: (q.options || []).map((o) => ({ label: o.label, detail: o.description || "" })), recommended: (q.options || []).findIndex((o) => /recommended/i.test(`${o.label} ${o.description}`)) })), raw: r.input });
    } else if (r.tool_name === "ExitPlanMode") {
      out.push({ t: "approve", id: m.request_id, kind: "plan", title: "Plan ready", plan: String(r.input?.plan || "").slice(0, 12000) });
    } else {
      const d = describeTool(r.tool_name, r.input);
      out.push({ t: "approve", id: m.request_id, toolId: r.tool_use_id, kind: d.kind, title: d.title, detail: d.detail, diff: d.diff, reason: r.decision_reason || "" });
    }
  } else if (m.type === "rate_limit_event") {
    const r = m.rate_limit_info || {}; if (r.utilization != null || r.status) out.push({ t: "limits", usedPercent: r.utilization != null ? Math.round(r.utilization * 100) : null, status: r.status || "", resetsAt: r.resetsAt || null });
  } else if (m.type === "result") {
    if (m.is_error || (m.subtype && m.subtype !== "success")) out.push({ t: "error", message: explainError(m.result || m.subtype) });
    out.push({ t: "usage", cost: m.total_cost_usd, ms: m.duration_ms }); out.push({ t: "done" });
  }
  return out;
}
export function explainError(s = "") {
  const t = String(s);
  if (/not logged in|login|authenticat|401|invalid api key/i.test(t)) return "Claude Code is not signed in. Press “Sign in to Claude” above.";
  if (/rate.?limit|usage limit|429|quota/i.test(t)) return "Your Claude plan's usage limit is reached for now. Try again later, or switch to Codex or Other models.";
  if (/overloaded|529/i.test(t)) return "Claude is busy right now. Try again in a minute.";
  return `Claude Code stopped: ${t.slice(0, 300)}`;
}

// The answer Claude Code expects for a permission or question request.
export function controlResponse(requestId, req, answer) {
  if (req.tool_name === "AskUserQuestion") {
    const answers = {}; (req.input?.questions || []).forEach((q, i) => { answers[q.question] = Array.isArray(answer?.[i]) ? answer[i].join(", ") : String(answer?.[i] ?? ""); });
    return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: { ...req.input, answers } } } };
  }
  // "Allow for this chat": edits → auto-accept edits from now on; a command → allow that program (e.g. all `npm …`) for this chat.
  if (answer === "session") {
    const first = String(req.input?.command || "").trim().split(/\s+/)[0] || "";
    const perm = req.tool_name === "Bash" ? (first ? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: `${first}:*` }], behavior: "allow", destination: "session" }] : [])
      : /Edit|Write/.test(req.tool_name) ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }] : [{ type: "addRules", rules: [{ toolName: req.tool_name }], behavior: "allow", destination: "session" }];
    return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: req.input, updatedPermissions: perm } } };
  }
  if (req.tool_name === "ExitPlanMode" && answer) return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: req.input, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] } } };
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: answer ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "The user chose not to allow this. Ask what they want instead, or continue without it." } } };
}

export function startClaude({ bin = "claude", cwd, env, model, effort, resume, rules, mode = "ask", emit, onExit }) {
  const p = spawn(bin, claudeArgs({ model, effort, resume, rules, mode }), { cwd, env: { ...env, DISABLE_AUTOUPDATER: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  const state = { tools: {}, pendingReq: {}, sessionId: null, stderr: "" };
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "control_request") state.pendingReq[m.request_id] = m.request;
      for (const e of translate(m, state)) emit(e);
    }
  });
  p.stderr.on("data", (d) => { state.stderr = (state.stderr + d).slice(-4000); });
  p.on("exit", (code) => { if (code && code !== 143) emit({ t: "error", message: explainError(state.stderr || `exit ${code}`) }); emit({ t: "idle" }); onExit?.(state); });
  p.on("error", (e) => emit({ t: "error", message: `Could not start Claude Code: ${e.message}` }));
  return {
    state,
    send(text, files, root) { p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: userContent(text, files, root) } }) + "\n"); },
    answer(requestId, answer) { const req = state.pendingReq[requestId]; if (!req) return false; delete state.pendingReq[requestId]; p.stdin.write(JSON.stringify(controlResponse(requestId, req, answer)) + "\n"); return true; },
    interrupt() { p.stdin.write(JSON.stringify({ type: "control_request", request_id: `int-${Date.now()}`, request: { subtype: "interrupt" } }) + "\n"); },
    stop() { try { p.kill(); } catch { /* gone */ } },
    get alive() { return p.exitCode === null; },
  };
}
