import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../server/agent.mjs";
import { createFounderPilot, parseContract } from "../server/founder-pilot.mjs";

const contract = { summary: "Save corrections separately", acceptanceCriteria: ["Save feedback", "Link revised contract"], edgeCases: ["Provider timeout"], openQuestions: [] };

test("tool requests do not count as a delivered contract", () => {
  assert.throws(() => parseContract('{"action":"list_dir","path":"."}'));
  assert.throws(() => parseContract('{"summary":"partial"}'));
  assert.deepEqual(parseContract(JSON.stringify(contract)), contract);
});

test("restricted Studio turn executes read tool and rejects an unadvertised write", async t => {
  const root = mkdtempSync(join(tmpdir(), "pilot-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "README.md"), "existing context");
  const requests = [], observations = [];
  const messages = [{ role: "user", content: "Read files" }];
  const sse = delta => new Response("data: " + JSON.stringify({ choices: [{ delta }] }) + "\n\ndata: [DONE]\n\n");
  let count = 0;
  await runTurn({
    root, messages, systemPrompt: "Read only", provider: { id: "nvidia", base: "http://test.invalid" },
    model: "test", maxRounds: 3, maxTokens: 1200, allowedTools: ["list_files", "read_file"],
    emit() {}, observe: event => observations.push(event), approve: () => { throw new Error("Should not request write approval"); },
    fetchImpl: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      if (count++ === 0) return sse({ tool_calls: [
        { index: 0, id: "read", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
        { index: 1, id: "write", function: { name: "write_file", arguments: '{"path":"bad.txt","content":"bad"}' } }
      ] });
      return sse({ content: JSON.stringify(contract) });
    }
  });
  assert.deepEqual(requests[0].tools.map(x => x.function.name), ["list_files", "read_file"]);
  assert.equal(requests[0].max_tokens, 1200);
  assert.match(requests[1].messages.find(m => m.tool_call_id === "read").content, /existing context/);
  assert.match(requests[1].messages.find(m => m.tool_call_id === "write").content, /not available/);
  assert.equal(existsSync(join(root, "bad.txt")), false);
  assert.deepEqual(parseContract(messages.at(-1).content), contract);
  assert.equal(observations.filter(e => e.type === "model.request").length, 2);
  assert.deepEqual(observations.filter(e => e.type === "tool.result").map(e => [e.tool, e.outcome]),
    [["read_file", "ok"], ["write_file", "blocked"]]);
  assert.ok(observations.every(e => !("args" in e) && !("result" in e)));
});

test("legacy attempt is rejected, corrections remain durable, and only latest valid contract is accepted", async t => {
  const root = mkdtempSync(join(tmpdir(), "pilot-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const org = join(root, "org");
  for (const d of ["scripts", "org/agents", "playbooks"]) mkdirSync(join(org, d), { recursive: true });
  writeFileSync(join(org, "scripts/agent-router.mjs"), 'export const route=()=>({action:"run",engine:"free",role:"maya-ai-pm",free_model:"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"}); export const agentInfo=()=>({name:"Maya"});');
  writeFileSync(join(org, "org/agents/maya-ai-pm.md"), "role");
  writeFileSync(join(org, "playbooks/ai-pm.md"), "playbook");
  const keyFile = join(root, "key.json");
  writeFileSync(keyFile, '{"nvidia":{"key":"mock-only"}}');
  const dir = join(root, "history");
  mkdirSync(dir);
  const id = "studio-pilot-001";
  const file = join(dir, id + ".json");
  writeFileSync(file, JSON.stringify([{ revision: 1, status: "failed", feedback: "", agents: [{ agent: "Maya", output: '{"action":"list_dir"}' }], error: "timeout" }]));
  let calls = 0;
  const config = { dir, orgDir: org, keyFile, inbox: { list: () => [{ requestId: id, title: "Feedback", description: "Correction workflow" }] },
    runner: async ({messages, emit, allowedTools, observe}) => {
      calls++;
      assert.deepEqual(allowedTools, ["list_files", "read_file"]);
      assert.match(messages[0].content, /Preserve original feedback/);
      observe({ type: "model.request", requestedModel: "nvidia/nemotron-3-ultra-550b-a55b", round: 1 });
      observe({ type: "model.headers", httpStatus: 200, round: 1 });
      observe({ type: "model.result", round: 1, finish: "stop", inputTokens: 100, outputTokens: 200 });
      messages.push({ role: "assistant", content: JSON.stringify(contract) });
      emit({ t: "done" });
    }
  };
  let pilot = createFounderPilot(config);
  assert.equal(pilot.history(id)[0].agents.length, 0);
  assert.equal(pilot.history(id)[0].attempts.length, 1);
  assert.equal(pilot.run({ requestId: id, action: "save", revision: 1, feedback: "Preserve original feedback" }).status, "queued");
  assert.equal(calls, 0);
  pilot = createFounderPilot(config);
  assert.equal(pilot.history(id)[1].feedback, "Preserve original feedback");
  assert.throws(() => pilot.run({ requestId: id, action: "accept", revision: 1 }));
  assert.equal(pilot.run({ requestId: id, action: "run", revision: 2 }).status, "running");
  assert.throws(() => pilot.run({ requestId: id, action: "run", revision: 2 }));
  for (let i = 0; i < 100 && pilot.history(id)[1].status === "running"; i++) await new Promise(r => setTimeout(r, 10));
  const current = pilot.history(id)[1];
  assert.equal(current.status, "founder-review", current.error);
  assert.equal(calls, 1);
  assert.deepEqual(current.contract, contract);
  assert.equal(pilot.run({ requestId: id, action: "accept", revision: 2 }).status, "contract-accepted");
  assert.equal(JSON.parse(readFileSync(file))[1].status, "contract-accepted");
  const events = createFounderPilot(config).evidence().events;
  const offer = events.find(e => e.type === "handoff.offered");
  const ack = events.find(e => e.type === "handoff.acknowledged");
  assert.equal(offer.artifactHash, ack.artifactHash);
  assert.equal(offer.executionId, ack.executionId);
  assert.equal(offer.toRole, "founder");
  assert.equal(events.filter(e => e.type === "model.request").length, 1);
  assert.equal(events.filter(e => e.type === "run.completed").length, 1);
  assert.ok(!readFileSync(join(dir, "execution-events.jsonl"), "utf8").includes("Preserve original feedback"));
  assert.ok(!readFileSync(join(dir, "execution-events.jsonl"), "utf8").includes("mock-only"));
  assert.ok(events.findIndex(e => e.type === "artifact.saved") < events.findIndex(e => e.type === "handoff.offered"));
  // A later failed attempt must not manufacture a handoff, or erase the accepted contract.
  pilot = createFounderPilot({ ...config, runner: async ({ observe }) => {
    observe({ type: "model.request", round: 1 });
    throw new DOMException("PRIVATE_PROVIDER_DETAILS", "TimeoutError");
  } });
  pilot.run({ requestId: id, action: "save", revision: 2, feedback: "Add another edge case" });
  pilot.run({ requestId: id, action: "run", revision: 3 });
  for (let i = 0; i < 100 && pilot.history(id)[2].status === "running"; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(pilot.history(id)[2].status, "failed");
  assert.equal(pilot.history(id)[1].status, "contract-accepted");
  const failedEvents = pilot.evidence().events.filter(e => e.revision === 3);
  assert.equal(failedEvents.find(e => e.type === "run.failed").errorKind, "timeout");
  assert.ok(!failedEvents.some(e => e.type === "handoff.offered"));
  assert.ok(!readFileSync(join(dir, "execution-events.jsonl"), "utf8").includes("PRIVATE_PROVIDER_DETAILS"));

});
