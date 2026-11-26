// The Studio-drawn chat agent for "Other models": an OpenAI-compatible tool-calling loop.
// It works inside one product folder. Reading is automatic; changing files or running commands asks the user first
// (unless they chose "Auto-approve" for that chat). Read-only commands on an allow-list run without asking.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve, relative, dirname, sep } from "node:path";
import { planEnv } from "./billing.mjs";

export const TOOLS = [
  { name: "list_files", desc: "List files and folders under a path in the product (default: the product root).",
    params: { path: { type: "string", description: "Folder, relative to the product root" }, depth: { type: "integer", description: "1-4, default 2" } }, required: [] },
  { name: "read_file", desc: "Read a text file from the product. Long files: pass start_line/end_line.",
    params: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, required: ["path"] },
  { name: "search", desc: "Search the product's files for text (a regular expression). Returns matching lines with file and line number.",
    params: { pattern: { type: "string" }, path: { type: "string", description: "Folder to search, default the product root" } }, required: ["pattern"] },
  { name: "write_file", desc: "Create or replace a whole file in the product. Asks the user first.",
    params: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  { name: "edit_file", desc: "Replace one exact piece of text in a file (old_text must appear exactly once). Asks the user first.",
    params: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
  { name: "ask_user", desc: "Ask the product owner to decide something. Use this for EVERY decision that is theirs (product scope, behaviour, priorities, trade-offs), instead of writing options in your reply. Give 2-4 options, mark exactly one as recommended, and keep each option to one line plus a short consequence. Technical choices are yours: do not ask about them.",
    params: { question: { type: "string", description: "One short plain-language question" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, detail: { type: "string", description: "One-line consequence" } }, required: ["label"] } }, recommended: { type: "integer", description: "0-based index of the recommended option" } }, required: ["question", "options", "recommended"] },
  { name: "run_command", desc: "Run a shell command in the product folder (git, gh, npm, tests…). Asks the user first unless it is a read-only command such as git status or gh issue list. 2-minute limit.",
    params: { command: { type: "string" } }, required: ["command"] },
];
export const toolSchemas = () => TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.desc, parameters: { type: "object", properties: t.params, required: t.required } } }));

const READ_ONLY_CMD = [
  /^git (status|log|diff|show|branch|remote -v|ls-files|rev-parse|blame)\b/, /^gh (issue|pr|run|repo|release|label) (list|view|status|diff|checks)\b/,
  /^gh api (?!.*(-X|--method|-f |-F |--field|--input))\S+$/, /^(ls|pwd|cat|head|tail|wc|tree|find|grep|rg|node --version|npm (ls|view|--version))\b/,
];
export const isReadOnlyCommand = (c = "") => !/[;&|`$<>]|\b(rm|mv|cp|chmod|curl|wget|sudo)\b/.test(c.replace(/\|\s*(head|tail|grep|wc)\b[^|;&]*/g, "")) && READ_ONLY_CMD.some((r) => r.test(c.trim()));
export function normalizeQuestion(args = {}) {
  const options = (Array.isArray(args.options) ? args.options : []).map((o) => (typeof o === "string" ? { label: o } : o)).filter((o) => o && o.label).slice(0, 4)
    .map((o) => ({ label: String(o.label).slice(0, 200), detail: o.detail ? String(o.detail).slice(0, 300) : "" }));
  if (!args.question || options.length < 2) return null;
  const rec = Number.isInteger(args.recommended) && args.recommended >= 0 && args.recommended < options.length ? args.recommended : 0;
  return { question: String(args.question).slice(0, 500), options, recommended: rec };
}
export const needsApproval = (name, args = {}) => name === "write_file" || name === "edit_file" || (name === "run_command" && !isReadOnlyCommand(args.command));

// Keep every path inside the product folder (no "..", no symlink escapes). "garage/…" maps to the Garage folder
// when one is given (root = { product, garage } or a plain product path).
export function safePath(rootIn, p = ".") {
  let root = rootIn;
  if (typeof rootIn === "object") { const g = String(p).replace(/^\/+/, ""); if (rootIn.garage && /^garage(\/|$)/.test(g)) { root = rootIn.garage; p = g.replace(/^garage\/?/, "") || "."; } else root = rootIn.product; }
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, String(p).replace(/^\/+/, ""));
  if (abs !== rootReal && !abs.startsWith(rootReal + sep)) throw new Error(`path is outside the product folder: ${p}`);
  let probe = abs; while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`path is outside the product folder: ${p}`);
  if (relative(rootReal, abs).split(sep)[0] === ".git") throw new Error("the .git folder is off limits");
  return abs;
}
const cap = (s, n = 20000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters cut)` : s);
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".expo", "coverage", ".turbo"]);

export async function runTool(root, name, args = {}, { shell = "bash", timeoutMs = 120000 } = {}) {
  switch (name) {
    case "list_files": {
      const base = safePath(root, args.path || "."), depth = Math.max(1, Math.min(4, args.depth || 2)), out = [];
      const walk = (d, lvl) => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (SKIP.has(e.name)) continue;
          out.push(`${"  ".repeat(lvl)}${e.name}${e.isDirectory() ? "/" : ""}`);
          if (out.length > 600) return;
          if (e.isDirectory() && lvl + 1 < depth) walk(join(d, e.name), lvl + 1);
        }
      };
      walk(base, 0); return out.join("\n") || "(empty)";
    }
    case "read_file": {
      const f = safePath(root, args.path);
      if (statSync(f).size > 2_000_000) return "File is larger than 2 MB; read a range with start_line/end_line after searching it.";
      const lines = readFileSync(f, "utf8").split("\n"), s = Math.max(1, args.start_line || 1), e = Math.min(lines.length, args.end_line || s + 399);
      return cap(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join("\n")) + (e < lines.length ? `\n(lines ${s}-${e} of ${lines.length})` : "");
    }
    case "search": {
      const base = safePath(root, args.path || ".");
      return new Promise((ok) => execFile("grep", ["-rnIE", "--exclude-dir=node_modules", "--exclude-dir=.git", "-m", "20", String(args.pattern), "."], { cwd: base, maxBuffer: 8 << 20, timeout: 30000 },
        (e, out) => ok(cap(out || (e && e.code === 1 ? "No matches." : `Search failed: ${e?.message}`), 15000))));
    }
    case "write_file": {
      const f = safePath(root, args.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, String(args.content ?? ""));
      return `Wrote ${args.path} (${String(args.content ?? "").split("\n").length} lines).`;
    }
    case "edit_file": {
      const f = safePath(root, args.path), text = readFileSync(f, "utf8"), n = text.split(String(args.old_text)).length - 1;
      if (n !== 1) return `Not changed: old_text appears ${n} times (it must appear exactly once). Read the file and use a longer, unique piece.`;
      writeFileSync(f, text.replace(String(args.old_text), () => String(args.new_text))); return `Edited ${args.path}.`;
    }
    case "run_command":
      // Plain (non-login) shell: login shells print welcome banners (e.g. Cloud Shell's) into every result.
      // The Studio's own environment already carries the user's PATH, so tools like gh, git and npm are found.
      return new Promise((ok) => execFile(shell, ["-c", String(args.command)], { cwd: realpathSync(typeof root === "object" ? root.product : root), timeout: timeoutMs, maxBuffer: 16 << 20, env: { ...planEnv(), GH_PAGER: "", PAGER: "cat", GIT_PAGER: "cat", CI: "1" } },
        (e, out, err) => ok(cap(`exit ${e ? (e.killed ? "timeout" : e.code ?? 1) : 0}\n${out || ""}${err ? `\n[stderr]\n${err}` : ""}`))));
    default: return `Unknown tool ${name}`;
  }
}

// Reads an OpenAI-compatible streamed response (Server-Sent Events) into text + tool calls.
export async function readStream(body, onText) {
  const dec = new TextDecoder(); let buf = "", text = "", finish = null, usage = null; const calls = [];
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens };
      const ch = j.choices?.[0]; if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (d.content) { text += d.content; onText?.(d.content); }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? calls.length;
        calls[k] ||= { id: tc.id || `call_${k}`, name: "", args: "" };
        if (tc.id) calls[k].id = tc.id;
        if (tc.function?.name) calls[k].name += tc.function.name;
        if (tc.function?.arguments) calls[k].args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { text, calls: calls.filter(Boolean), finish, usage };
}

// One user turn: call the model, run tools (asking when needed), repeat until the model answers without tools.
// emit(event) streams to the browser; approve(call) resolves true/false.
// How each provider takes a thinking/effort level. Unknown providers get the common OpenAI field.
export function effortFields(providerId, effort) {
  if (!effort || effort === "default") return {};
  if (providerId === "openrouter") return { reasoning: { effort } };
  if (providerId === "anthropic") return {};            // Anthropic's OpenAI layer ignores it; use Claude Code for thinking control
  return { reasoning_effort: effort };
}
// apps: [{ name, app, tool, description, schema, session, readOnly }] from mcp-client.openApps — connected apps (MCP).
// roots: extra folders the agent may read/write besides the product (e.g. the Garage).
export async function runTurn({ messages, provider, model, effort, root, systemPrompt, emit, approve, auto = false, askUser, signal, fetchImpl = fetch, maxRounds = 30, apps = [] }) {
  const appSchemas = apps.map((a) => ({ type: "function", function: { name: a.name, description: `[${a.app}] ${a.description}`, parameters: a.schema?.type === "object" ? a.schema : { type: "object", properties: {} } } }));
  let extra = effortFields(provider.id, effort);
  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) return emit({ t: "stopped" });
    const call = () => fetchImpl(`${provider.base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}), ...(provider.extraHeaders || {}) },
      body: JSON.stringify({ model, stream: true, messages: [{ role: "system", content: systemPrompt }, ...messages], tools: [...toolSchemas(), ...appSchemas], tool_choice: "auto", ...(["openai", "openrouter"].includes(provider.id) ? { stream_options: { include_usage: true } } : {}), ...extra }),
    });
    let res = await call();
    // Some models refuse a thinking level they do not support: retry once without it and say so.
    if (!res.ok && res.status === 400 && Object.keys(extra).length) {
      const body = (await res.text()).slice(0, 300);
      if (/reason|effort|think/i.test(body)) { extra = {}; emit({ t: "note", message: `This model does not take a thinking level; continuing without “${effort}”.` }); res = await call(); }
      else res = { ok: false, status: 400, text: async () => body };
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      const hint = res.status === 401 ? "The key was rejected. Re-enter it under Keys." : res.status === 429 ? "Rate limit or free quota reached. Wait a minute or pick another model." : res.status === 404 ? "This model is not available with this key. Pick another model." : "";
      throw new Error(`${res.status} ${hint || body}`);
    }
    emit({ t: "assistant_start" });
    const { text, calls, usage } = await readStream(res.body, (d) => emit({ t: "delta", d }));
    emit({ t: "usage", models: [{ model, input: usage?.input, output: usage?.output }] });
    messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) } : {}) });
    if (!calls.length) return emit({ t: "done" });
    for (const c of calls) {
      let args; try { args = JSON.parse(c.args || "{}"); } catch { args = null; }
      let result;
      if (!args) result = "Your tool arguments were not valid JSON. Try again.";
      else if (apps.some((a) => a.name === c.name)) {
        // Connected apps were approved when the user connected them, so their tools run without a per-call question.
        const a = apps.find((x) => x.name === c.name);
        emit({ t: "tool", id: c.id, name: c.name, args, ask: false, app: a.app, tool: a.tool });
        try { const r = await a.session.callTool(a.tool, args); result = (r.isError ? "The app returned an error: " : "") + r.text; } catch (e) { result = `Error: ${e.message}`; }
      }
      else if (!TOOLS.some((t) => t.name === c.name)) result = `There is no tool named ${c.name}.`;
      else if (c.name === "ask_user") {
        const q = normalizeQuestion(args);
        if (!q) result = "ask_user needs a question and 2-4 options. Try again.";
        else {
          emit({ t: "ask", id: c.id, ...q });
          const answer = askUser ? await askUser({ id: c.id, ...q }) : null;
          if (signal?.aborted) return emit({ t: "stopped" });
          result = answer ? `The product owner chose: ${answer}` : "The product owner did not answer. Wait for them; do not decide for them.";
          emit({ t: "answered", id: c.id, answer: answer || "" });
          messages.push({ role: "tool", tool_call_id: c.id, content: result });
          continue;
        }
      }
      else {
        const ask = !auto && needsApproval(c.name, args);
        emit({ t: "tool", id: c.id, name: c.name, args, ask });
        const ok = ask ? await approve({ id: c.id, name: c.name, args }) : true;
        if (signal?.aborted) return emit({ t: "stopped" });
        if (!ok) result = "The user declined this action. Ask what they want instead, or continue without it.";
        else { try { result = await runTool(root, c.name, args); } catch (e) { result = `Error: ${e.message}`; } }
      }
      emit({ t: "tool_result", id: c.id, result: String(result).slice(0, 4000) });
      messages.push({ role: "tool", tool_call_id: c.id, content: String(result) });
    }
  }
  emit({ t: "error", message: `Stopped after ${maxRounds} steps to stay safe. Say "continue" to keep going.` });
}
