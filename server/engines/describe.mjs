// Plain-language labels for what an AI tool is doing, shared by Claude Code, Codex and Other models.
// "active" is the live line under the chat ("Reading NeedsYou.tsx…"), "title"/"detail" go on the card.
const short = (p = "") => String(p).split("/").filter(Boolean).slice(-2).join("/") || String(p);
const lines = (s = "") => (s ? String(s).split("\n").length : 0);

const base = (p = "") => String(p).split("/").filter(Boolean).pop() || String(p);
// Codex tells us what a shell command does (read a file, search, list files). Use that instead of showing the command.
export function describeCommand(command = "", actions = []) {
  const cmd = String(command).replace(/^\/bin\/(ba)?sh -lc '(.*)'$/s, "$2").replace(/^\/bin\/(ba)?sh -lc "(.*)"$/s, "$2");
  const acts = (actions || []).filter(Boolean);
  if (acts.length && acts.every((a) => a.type === "read")) { const names = [...new Set(acts.map((a) => a.name || base(a.path)))]; return { kind: "read", active: `Reading ${names[0]}`, title: names.length > 1 ? `Read ${names.length} files` : `Read ${names[0]}`, detail: names.length > 1 ? names.join(", ") : "", cmd }; }
  if (acts.length && acts.every((a) => a.type === "search")) return { kind: "search", active: `Searching${acts[0].query ? ` for “${acts[0].query.slice(0, 40)}”` : ""}`, title: acts[0].query ? `Searched for “${acts[0].query.slice(0, 60)}”` : "Searched the project", detail: "", cmd };
  if (acts.length && acts.every((a) => a.type === "listFiles")) return { kind: "search", active: "Looking at the files", title: `Listed files${acts[0].path ? ` in ${short(acts[0].path)}` : ""}`, detail: "", cmd };
  if (acts.length && acts.every((a) => ["read", "search", "listFiles"].includes(a.type))) return { kind: "search", active: "Exploring the project", title: `Explored the project (${acts.length} steps)`, detail: "", cmd };
  // Recognise a few everyday commands for a friendlier title.
  const first = cmd.trim().split(/\s+/).slice(0, 3).join(" ");
  const named = /^git (status|diff|log)/.test(first) ? "Checked the code changes" : /^gh auth status/.test(first) ? "Checked the GitHub sign-in" : /^gh (pr|issue|run)\b/.test(first) ? `Checked GitHub (${first.split(" ")[1]}s)` :
    /^npm (test|run test)|^npx (vitest|playwright|jest)/.test(first) ? "Ran the tests" : /^npm (ci|install|i)\b/.test(first) ? "Installed dependencies" : /^git (add|commit|push|checkout|switch)/.test(first) ? `Git: ${first.split(" ")[1]}` : "";
  return { kind: "run", active: named ? `${named.replace(/^Checked/, "Checking").replace(/^Ran/, "Running").replace(/^Installed/, "Installing")}` : `Running ${cmd.slice(0, 50)}`, title: named || "Ran a command", detail: cmd.slice(0, 600), cmd };
}
const MCP_NAMES = { github: "GitHub", gmail: "Gmail", google_drive: "Google Drive", slack: "Slack", linear: "Linear", notion: "Notion", supabase: "Supabase", vercel: "Vercel", figma: "Figma" };
export function describeMcp(server = "", tool = "") {
  server = String(server).replace(/^claude_ai_/i, "");
  const app = MCP_NAMES[String(server).toLowerCase()] || String(server).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const what = String(tool).replace(/^(get|list|search|read|fetch)_?/i, (m) => m.replace(/_$/, "") + " ").replace(/[_-]+/g, " ").trim();
  return { kind: "app", active: `Using ${app}`, title: `${app}: ${what}`, detail: "" };
}

export function describeTool(name = "", input = {}) {
  const n = String(name);
  const i = input || {};
  switch (n) {
    case "Read": case "read_file": { const f = i.file_path || i.path || ""; return { kind: "read", active: `Reading ${base(f) || "a file"}`, title: `Read ${base(f)}`, detail: short(f) !== base(f) ? short(f).split("/").slice(0, -1).join("/") : "" }; }
    case "Write": case "write_file": return { kind: "edit", active: `Writing ${short(i.file_path || i.path) || "a file"}`, title: `Create ${short(i.file_path || i.path)}`, detail: `${lines(i.content)} lines`, diff: { added: String(i.content || "").slice(0, 6000) } };
    case "Edit": case "edit_file": case "MultiEdit": {
      const f = short(i.file_path || i.path);
      const edits = i.edits || [{ old_string: i.old_string ?? i.old_text, new_string: i.new_string ?? i.new_text }];
      return { kind: "edit", active: `Editing ${f || "a file"}`, title: `Edit ${f}`, detail: `+${edits.reduce((a, e) => a + lines(e.new_string), 0)} −${edits.reduce((a, e) => a + lines(e.old_string), 0)}`,
        diff: { removed: edits.map((e) => e.old_string || "").join("\n…\n").slice(0, 4000), added: edits.map((e) => e.new_string || "").join("\n…\n").slice(0, 4000) } };
    }
    case "Bash": case "run_command": case "commandExecution": {
      const d = describeCommand(i.command || i.cmd || "", i.commandActions);
      return i.description ? { ...d, title: i.description } : d;
    }
    case "Glob": case "Grep": case "search": case "list_files": case "LS":
      return { kind: "search", active: `Searching${i.pattern ? ` for “${String(i.pattern).slice(0, 40)}”` : " the project"}`, title: i.pattern ? `Searched “${String(i.pattern).slice(0, 60)}”` : "Looked at files", detail: i.path ? short(i.path) : "" };
    case "WebSearch": case "webSearch": { const q = i.query || i.action?.query || (i.action?.queries || [])[0] || ""; const u = i.action?.url;
      return { kind: "web", active: "Searching the web", title: u ? `Opened ${String(u).replace(/^https?:\/\//, "").slice(0, 60)}` : q ? `Searched the web for “${String(q).slice(0, 70)}”` : "Searched the web", detail: "" }; }
    case "WebFetch": return { kind: "web", active: `Opening a web page`, title: `Opened ${String(i.url || "").replace(/^https?:\/\//, "").slice(0, 60)}`, detail: "" };
    case "TodoWrite": case "plan": return { kind: "plan", active: "Planning the steps", title: "Updated the plan", detail: (i.todos || []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"} ${t.content}`).join("\n").slice(0, 2000) };
    case "AskUserQuestion": case "request_user_input": return { kind: "ask", active: "Preparing a question for you", title: "Question", detail: "" };
    case "ExitPlanMode": return { kind: "plan", active: "Preparing a plan for you", title: "Plan ready", detail: String(i.plan || "").slice(0, 3000) };
    case "Task": case "Agent": return { kind: "agent", active: `Asking a helper agent`, title: `Helper agent: ${String(i.description || i.subagent_type || "task").slice(0, 60)}`, detail: "" };
    case "fileChange": return { kind: "edit", active: "Changing files", title: `Change ${(i.changes || []).map((c) => short(c.path)).slice(0, 3).join(", ")}`, detail: `${(i.changes || []).length} file(s)`, diff: { patch: (i.changes || []).map((c) => c.diff || "").join("\n").slice(0, 6000) } };
    default: {
      const m = n.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/) || n.match(/^([a-z0-9_-]+)\.(.+)$/i);
      if (m) return describeMcp(m[1], m[2]);
      return { kind: "tool", active: `Using ${n}`, title: n.replace(/[_-]+/g, " "), detail: "" };
    }
  }
}
