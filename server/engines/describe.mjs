// Plain-language labels for what an AI tool is doing, shared by Claude Code, Codex and Other models.
// "active" is the live line under the chat ("Reading NeedsYou.tsx…"), "title"/"detail" go on the card.
const short = (p = "") => String(p).split("/").filter(Boolean).slice(-2).join("/") || String(p);
const lines = (s = "") => (s ? String(s).split("\n").length : 0);

export function describeTool(name = "", input = {}) {
  const n = String(name);
  const i = input || {};
  switch (n) {
    case "Read": case "read_file": return { kind: "read", active: `Reading ${short(i.file_path || i.path) || "a file"}`, title: `Read ${short(i.file_path || i.path)}`, detail: "" };
    case "Write": case "write_file": return { kind: "edit", active: `Writing ${short(i.file_path || i.path) || "a file"}`, title: `Create ${short(i.file_path || i.path)}`, detail: `${lines(i.content)} lines`, diff: { added: String(i.content || "").slice(0, 6000) } };
    case "Edit": case "edit_file": case "MultiEdit": {
      const f = short(i.file_path || i.path);
      const edits = i.edits || [{ old_string: i.old_string ?? i.old_text, new_string: i.new_string ?? i.new_text }];
      return { kind: "edit", active: `Editing ${f || "a file"}`, title: `Edit ${f}`, detail: `+${edits.reduce((a, e) => a + lines(e.new_string), 0)} −${edits.reduce((a, e) => a + lines(e.old_string), 0)}`,
        diff: { removed: edits.map((e) => e.old_string || "").join("\n…\n").slice(0, 4000), added: edits.map((e) => e.new_string || "").join("\n…\n").slice(0, 4000) } };
    }
    case "Bash": case "run_command": case "commandExecution": {
      const cmd = String(i.command || i.cmd || "").replace(/^\/bin\/bash -lc '(.*)'$/s, "$1");
      return { kind: "run", active: `Running: ${cmd.slice(0, 60)}`, title: i.description || `Run a command`, detail: cmd.slice(0, 400) };
    }
    case "Glob": case "Grep": case "search": case "list_files": case "LS":
      return { kind: "search", active: `Searching${i.pattern ? ` for “${String(i.pattern).slice(0, 40)}”` : " the project"}`, title: i.pattern ? `Searched “${String(i.pattern).slice(0, 60)}”` : "Looked at files", detail: i.path ? short(i.path) : "" };
    case "WebSearch": case "webSearch": return { kind: "web", active: `Searching the web`, title: `Web search: ${String(i.query || "").slice(0, 80)}`, detail: "" };
    case "WebFetch": return { kind: "web", active: `Opening a web page`, title: `Opened ${String(i.url || "").replace(/^https?:\/\//, "").slice(0, 60)}`, detail: "" };
    case "TodoWrite": case "plan": return { kind: "plan", active: "Planning the steps", title: "Updated the plan", detail: (i.todos || []).map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○"} ${t.content}`).join("\n").slice(0, 2000) };
    case "AskUserQuestion": case "request_user_input": return { kind: "ask", active: "Preparing a question for you", title: "Question", detail: "" };
    case "ExitPlanMode": return { kind: "plan", active: "Preparing a plan for you", title: "Plan ready", detail: String(i.plan || "").slice(0, 3000) };
    case "Task": case "Agent": return { kind: "agent", active: `Asking a helper agent`, title: `Helper agent: ${String(i.description || i.subagent_type || "task").slice(0, 60)}`, detail: "" };
    case "fileChange": return { kind: "edit", active: "Changing files", title: `Change ${(i.changes || []).map((c) => short(c.path)).slice(0, 3).join(", ")}`, detail: `${(i.changes || []).length} file(s)`, diff: { patch: (i.changes || []).map((c) => c.diff || "").join("\n").slice(0, 6000) } };
    default: return { kind: "tool", active: `Using ${n}`, title: n.replace(/^mcp__/, "").replace(/__/g, " · "), detail: "" };
  }
}
