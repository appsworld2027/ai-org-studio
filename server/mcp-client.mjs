// A small MCP client for the Studio's own chat ("Other models", incl. free ones): starts the connected apps' servers,
// lists their tools and calls them, so free models can use the same apps as Claude Code and Codex.
// Stdio servers only (remote OAuth apps such as Vercel are for Claude Code / Codex, which run their own sign-in).
import { spawn } from "node:child_process";

export function mcpSession({ command, args = [], env, name, timeoutMs = 90000 }) {
  const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  let buf = "", n = 0, err = "", dead = null; const waiting = new Map();
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const call = (method, params, ms = timeoutMs) => new Promise((ok, fail) => {
    if (dead) return fail(dead);
    const id = ++n; const t = setTimeout(() => { waiting.delete(id); fail(new Error(`${name}: no answer to ${method} within ${Math.round(ms / 1000)}s`)); }, ms);
    waiting.set(id, { ok: (r) => { clearTimeout(t); ok(r); }, fail: (e) => { clearTimeout(t); fail(e); } }); send({ id, method, params });
  });
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && waiting.has(m.id) && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.fail(new Error(m.error.message)) : w.ok(m.result); }
      else if (m.id != null && m.method) send({ id: m.id, error: { code: -32601, message: "not supported" } });   // server→client requests (sampling etc.)
    }
  });
  p.stderr.on("data", (d) => { err = (err + d).slice(-3000); });
  const die = (e) => { dead = e; for (const w of waiting.values()) w.fail(e); waiting.clear(); };
  p.on("error", (e) => die(new Error(`${name}: could not start (${e.message})`)));
  p.on("close", (code) => die(new Error(`${name}: stopped (exit ${code}) ${err.trim().split("\n").slice(-2).join(" ")}`.trim())));
  const ready = call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-org-studio", version: "2.2" } })
    .then(() => { send({ method: "notifications/initialized" }); return call("tools/list", {}); }).then((r) => r.tools || []);
  return {
    ready,
    async callTool(tool, args) { const r = await call("tools/call", { name: tool, arguments: args || {} }, 180000); return { isError: !!r.isError, text: (r.content || []).map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : JSON.stringify(c))).join("\n") }; },
    stop() { try { p.kill(); } catch { /* gone */ } },
  };
}

// Tool names for OpenAI-style function calling: mcp__<app>__<tool> (max 64 chars, safe characters).
export const toolName = (app, tool) => `mcp__${app}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

// Starts every enabled stdio app once per chat turn set; failures are reported, never fatal.
export async function openApps(servers, { env = process.env, log = () => {}, timeoutMs = 20000 } = {}) {
  const sessions = [], tools = [], problems = [];
  await Promise.all(servers.filter((s) => s.command).map(async (s) => {
    const m = mcpSession({ command: s.command, args: s.args, env, name: s.id, timeoutMs });
    try {
      const list = await m.ready; sessions.push(m);
      for (const t of list.slice(0, 60)) tools.push({ app: s.id, tool: t.name, name: toolName(s.id, t.name), description: String(t.description || "").slice(0, 900), schema: t.inputSchema || { type: "object", properties: {} }, session: m, readOnly: !!t.annotations?.readOnlyHint });
    } catch (e) { problems.push(`${s.id}: ${e.message}`); m.stop(); log(`apps: ${e.message}`); }
  }));
  return { tools, problems, close: () => sessions.forEach((m) => m.stop()) };
}
