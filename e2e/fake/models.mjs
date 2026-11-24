// Stand-in AI providers for tests: an Anthropic Messages API (for Claude Code) and an OpenAI Responses API (for Codex).
// Each answers with a scripted turn: say something, ask to change a file (needs approval), ask a question, then finish.
import http from "node:http";
export function startFakeModels({ anthropicPort, openaiPort, projectDir }) {
  const log = { anthropic: [], openai: [] };
  const anth = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      let j = {}; try { j = JSON.parse(body); } catch {}
      log.anthropic.push({ url: req.url, model: j.model, auth: req.headers["x-api-key"] || req.headers.authorization, lastUser: JSON.stringify(j.messages?.at(-1)?.content || "").slice(0, 200000), all: JSON.stringify(j.messages || []).slice(0, 400000) });
      if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"input_tokens":10}'); }
      const main = (j.tools || []).some((t) => t.name === "Write"); const last = JSON.stringify(j.messages?.at(-1)?.content || "");
      let blocks, stop = "end_turn";
      if (!main) blocks = [{ type: "text", text: "Dark mode note" }];
      else if (!last.includes("tool_result")) { blocks = [{ type: "text", text: "I'll write the **dark mode** note first." }, { type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: `${projectDir}/docs/claude-idea.md`, content: "# Idea\nDark mode\n" } }]; stop = "tool_use"; }
      else if (!last.includes("toolu_q1")) { blocks = [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input: { questions: [{ question: "Where should overdue fees show?", header: "Placement", multiSelect: false, options: [{ label: "Top of Fees (Recommended)", description: "Fastest to find" }, { label: "Separate tab", description: "More clicks" }] }] } }]; stop = "tool_use"; }
      else blocks = [{ type: "text", text: "Done. I saved the note and noted your choice." }];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: j.model || "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      blocks.forEach((b, i) => {
        if (b.type === "text") { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); for (const part of b.text.match(/.{1,10}/gs)) ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } }); }
        else { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
        ev("content_block_stop", { type: "content_block_stop", index: i });
      });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }); ev("message_stop", { type: "message_stop" }); res.end();
    });
  }).listen(anthropicPort, "127.0.0.1");
  const oai = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      if (!req.url.includes("/responses")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"data":[{"id":"gpt-fake","object":"model"}]}'); }
      let j = {}; try { j = JSON.parse(body); } catch {}
      log.openai.push({ model: j.model, effort: j.reasoning?.effort, input: JSON.stringify(j.input || "").slice(-2000) });
      const done = /function_call_output|custom_tool_call_output/.test(JSON.stringify(j.input || ""));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const id = `resp_${Date.now()}`, send = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      send("response.created", { response: { id, status: "in_progress" } });
      let item;
      if (!done) { item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hello > made-by-codex.txt", sandbox_permissions: "require_escalated", justification: "Create the file you asked for" }) }; send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } }); send("response.output_item.done", { output_index: 0, item }); }
      else { item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Created **made-by-codex.txt**." }] }; send("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }); for (const d of ["Created ", "**made-by-codex.txt**."]) send("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: d }); send("response.output_item.done", { output_index: 0, item }); }
      send("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); res.end();
    });
  }).listen(openaiPort, "127.0.0.1");
  return { log, close() { anth.close(); oai.close(); } };
}
