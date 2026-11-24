#!/usr/bin/env node
// A small read-only Vercel MCP server (stdio) for every AI in the Studio, using a Vercel access token.
// Why our own: Vercel's official MCP (mcp.vercel.com) signs in through a browser redirect to this machine,
// which does not work on Cloud Shell / a remote box. The token is read from VERCEL_TOKEN (given only to this process).
// Tools: list_projects, list_deployments, get_deployment, get_build_logs, find_preview_for_branch.
const API = process.env.VERCEL_API || "https://api.vercel.com";
const TOKEN = process.env.VERCEL_TOKEN || "";
const TEAM = process.env.VERCEL_TEAM_ID || "";
const q = (o) => { const s = new URLSearchParams(Object.entries({ ...o, ...(TEAM ? { teamId: TEAM } : {}) }).filter(([, v]) => v !== undefined && v !== "")).toString(); return s ? `?${s}` : ""; };
async function v(path, params = {}) {
  const r = await fetch(`${API}${path}${q(params)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const t = await r.text(); if (!r.ok) throw new Error(`Vercel answered ${r.status}: ${t.slice(0, 200)}`); return JSON.parse(t);
}
const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const dep = (d) => ({ id: d.uid || d.id, url: d.url ? `https://${d.url}` : "", state: d.readyState || d.state, target: d.target || "preview", branch: d.meta?.githubCommitRef || "", commit: (d.meta?.githubCommitMessage || "").split("\n")[0].slice(0, 80), created: when(d.createdAt || d.created) });
export const TOOLS = {
  list_projects: { description: "List Vercel projects (name, id, framework, production URL).", schema: { type: "object", properties: {} },
    run: async () => (await v("/v9/projects", { limit: 50 })).projects.map((p) => ({ name: p.name, id: p.id, framework: p.framework, production: p.targets?.production?.alias?.[0] ? `https://${p.targets.production.alias[0]}` : "" })) },
  list_deployments: { description: "Latest deployments of a project (preview and production), newest first, with state and branch.", schema: { type: "object", properties: { project: { type: "string", description: "Project name or id" }, limit: { type: "integer" } }, required: ["project"] },
    run: async ({ project, limit = 10 }) => (await v("/v6/deployments", { projectId: project, limit: Math.min(50, limit) })).deployments.map(dep) },
  get_deployment: { description: "One deployment's details (state, URL, branch, error if it failed).", schema: { type: "object", properties: { id: { type: "string", description: "Deployment id or URL" } }, required: ["id"] },
    run: async ({ id }) => { const d = await v(`/v13/deployments/${encodeURIComponent(String(id).replace(/^https?:\/\//, ""))}`); return { ...dep(d), error: d.errorMessage || d.errorCode || "" }; } },
  get_build_logs: { description: "Build log lines of a deployment (use when a deployment failed).", schema: { type: "object", properties: { id: { type: "string" }, last: { type: "integer", description: "How many final lines, default 120" } }, required: ["id"] },
    run: async ({ id, last = 120 }) => (await v(`/v3/deployments/${encodeURIComponent(id)}/events`, { limit: -1 })).map((e) => e.payload?.text || e.text || "").filter(Boolean).slice(-Math.min(1000, last)).join("\n") },
  find_preview_for_branch: { description: "The newest ready preview URL for a git branch (to show the founder what to test).", schema: { type: "object", properties: { project: { type: "string" }, branch: { type: "string" } }, required: ["project", "branch"] },
    run: async ({ project, branch }) => { const all = (await v("/v6/deployments", { projectId: project, limit: 50 })).deployments.map(dep).filter((d) => d.branch === branch); return all.find((d) => d.state === "READY") || all[0] || `No deployment found for branch ${branch}.`; } },
};
export async function handle(m) {
  if (m.method === "initialize") return { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "vercel (AI Org Studio, read-only)", version: "1.0.0" } };
  if (m.method === "tools/list") return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: true } })) };
  if (m.method === "tools/call") {
    const t = TOOLS[m.params?.name]; if (!t) return { isError: true, content: [{ type: "text", text: `No tool ${m.params?.name}` }] };
    if (!TOKEN) return { isError: true, content: [{ type: "text", text: "Vercel is not connected: add a Vercel token in the Studio (Apps → Vercel)." }] };
    try { const r = await t.run(m.params.arguments || {}); return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 1) }] }; }
    catch (e) { return { isError: true, content: [{ type: "text", text: e.message }] }; }
  }
  return {};
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let buf = "";
  process.stdin.on("data", async (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id == null) continue;
      const result = await handle(m); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    }
  });
}
