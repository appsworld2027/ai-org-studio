#!/usr/bin/env node
// Minimal MCP stdio server for tests: one tool "whoami" that returns the env var it was given (proves keys arrive).
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "whoami", description: "Says which account the key belongs to", inputSchema: { type: "object", properties: {} } }] } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `account for key ${String(process.env.ECHO_KEY || "MISSING").slice(0, 6)}…` }] } });
    else if (m.id != null) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
