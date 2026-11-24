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
      // v2.1 scenario (message contains PLANCHECK): think, keep a plan (TodoWrite), read a file, write one, finish.
      const msgs = j.messages || [];
      const isText = (m) => m.role === "user" && (typeof m.content === "string" || (m.content || []).some((c) => c.type === "text" && !/^<system-reminder>/.test(c.text || "")));
      const startIdx = msgs.map(isText).lastIndexOf(true);
      const scenario2 = main && startIdx >= 0 && /PLANCHECK/.test(JSON.stringify(msgs[startIdx].content));
      if (scenario2) {
        const n = (JSON.stringify(msgs.slice(startIdx)).match(/"tool_result"/g) || []).length;
        const todos = (s) => [{ content: "Read the README", status: s[0], activeForm: "Reading the README" }, { content: "Write the summary note", status: s[1], activeForm: "Writing the note" }];
        if (n === 0) { blocks = [{ type: "thinking", thinking: "The founder wants a summary. I will read the README first, then write a short note." }, { type: "tool_use", id: "toolu_t1", name: "TodoWrite", input: { todos: todos(["in_progress", "pending"]) } }]; stop = "tool_use"; }
        else if (n === 1) { blocks = [{ type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: `${projectDir}/README.md` } }]; stop = "tool_use"; }
        else if (n === 2) { blocks = [{ type: "tool_use", id: "toolu_w2", name: "Write", input: { file_path: `${projectDir}/docs/summary.md`, content: "# Summary\nCoach and parent app.\n" } }]; stop = "tool_use"; }
        else if (n === 3) { blocks = [{ type: "tool_use", id: "toolu_t2", name: "TodoWrite", input: { todos: todos(["completed", "completed"]) } }]; stop = "tool_use"; }
        else blocks = [{ type: "text", text: "Summary written.\n\n```bash\ncat docs/summary.md\n```" }];
      }
      else if (!main) blocks = [{ type: "text", text: "Dark mode note" }];
      else if (!last.includes("tool_result")) { blocks = [{ type: "text", text: "I'll write the **dark mode** note first." }, { type: "tool_use", id: "toolu_w1", name: "Write", input: { file_path: `${projectDir}/docs/claude-idea.md`, content: "# Idea\nDark mode\n" } }]; stop = "tool_use"; }
      else if (!last.includes("toolu_q1")) { blocks = [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input: { questions: [{ question: "Where should overdue fees show?", header: "Placement", multiSelect: false, options: [{ label: "Top of Fees (Recommended)", description: "Fastest to find" }, { label: "Separate tab", description: "More clicks" }] }] } }]; stop = "tool_use"; }
      else blocks = [{ type: "text", text: "Done. I saved the note and noted your choice." }];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: j.model || "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4000, cache_read_input_tokens: 21000, output_tokens: 1 } } });
      blocks.forEach((b, i) => {
        if (b.type === "thinking") { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } }); for (const part of b.thinking.match(/.{1,20}/gs)) ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: part } }); ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig-test" } }); }
        else if (b.type === "text") { ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } }); for (const part of b.text.match(/.{1,10}/gs)) ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } }); }
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
      log.openai.push({ model: j.model, effort: j.reasoning?.effort, input: JSON.stringify(j.input || "").slice(-6000) });
      const inStr = JSON.stringify(j.input || "");
      const look = /LOOKAROUND/.test(inStr), outs = (inStr.slice(inStr.lastIndexOf("LOOKAROUND")).match(/function_call_output/g) || []).length;
      const done = look ? outs >= 2 : /function_call_output|custom_tool_call_output/.test(inStr);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const id = `resp_${Date.now()}`, send = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      send("response.created", { response: { id, status: "in_progress" } });
      let item;
      if (look && !done) {
        item = outs === 0 ? { type: "function_call", id: "fc_p", call_id: "call_p", name: "update_plan", arguments: JSON.stringify({ explanation: "Quick look first", plan: [{ step: "Read the README", status: "in_progress" }, { step: "Report back", status: "pending" }] }) }
          : { type: "function_call", id: "fc_r", call_id: "call_r", name: "exec_command", arguments: JSON.stringify({ cmd: "cat README.md" }) };
        send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } }); send("response.output_item.done", { output_index: 0, item });
      }
      else if (look) { item = { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "The README says it is a coach and parent app." }] }; send("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }); send("response.output_text.delta", { item_id: "msg_2", output_index: 0, content_index: 0, delta: item.content[0].text }); send("response.output_item.done", { output_index: 0, item }); }
      else if (!done) { item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: JSON.stringify({ cmd: "echo hello > made-by-codex.txt", sandbox_permissions: "require_escalated", justification: "Create the file you asked for" }) }; send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "" } }); send("response.output_item.done", { output_index: 0, item }); }
      else { item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Created **made-by-codex.txt**." }] }; send("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }); for (const d of ["Created ", "**made-by-codex.txt**."]) send("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: d }); send("response.output_item.done", { output_index: 0, item }); }
      send("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 24000, output_tokens: 5, total_tokens: 24005, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); res.end();
    });
  }).listen(openaiPort, "127.0.0.1");
  return { log, close() { anth.close(); oai.close(); } };
}
