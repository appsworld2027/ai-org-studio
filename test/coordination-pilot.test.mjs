import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { artifactDigest } from "../server/execution-journal.mjs";
import { runPlanningChain } from "../server/coordination-pilot.mjs";
import { createFounderPilot } from "../server/founder-pilot.mjs";

const contract = { summary: "Founder revisions", acceptanceCriteria: ["Save feedback", "Preserve history"], edgeCases: ["Timeout"], openQuestions: [] };
const output = (inputArtifactHash, contractArtifactHash) => ({
  inputArtifactHash, contractArtifactHash, summary: "Role-specific proposal",
  coverage: [{ criterionId: "AC-01", approach: "Check saved feedback" }, { criterionId: "AC-02", approach: "Check original revision remains" }],
  deliverables: ["Plan revision flow"], risks: ["Concurrent edits"]
});
test("supervised discovery runs the next real role routes, with matched independent artifact receipts", async t => {
  const root = mkdtempSync(join(tmpdir(), "studio-chain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const orgDir = join(root, "org"), dir = join(root, "history"), keyFile = join(root, "key.json");
  for (const d of ["scripts", "org/agents", "playbooks"]) mkdirSync(join(orgDir, d), { recursive: true });
  writeFileSync(keyFile, '{"nvidia":{"key":"mock-only"}}');
  writeFileSync(join(orgDir,"scripts/agent-router.mjs"), `export function route({labels, supervisedTrial}) {
    if (!supervisedTrial) throw Error("missing supervision");
    return {action:"run",engine:"free",role:{"ai:discovery":"maya-ai-pm","ai:plan":"arjun-cpto","ai:tests":"quinn-qa"}[labels[0]],free_model:"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"};
  } export const agentInfo=role=>({name:role});`);
  for (const role of ["maya-ai-pm", "arjun-cpto", "quinn-qa"])
    writeFileSync(join(orgDir,"org/agents",role+".md"), "Own role instructions: "+role);
  writeFileSync(join(orgDir,"playbooks/ai-pm.md"), "Discovery role");
  const id = "studio-pilot-001";
  const calls = [];
  const pilot = createFounderPilot({dir, orgDir, keyFile, inbox:{list:()=>[{requestId:id,title:"Synthetic feedback",description:"Save correction"}]},
    runner:async ({messages, systemPrompt, allowedTools, observe, emit, validateFinal})=>{
      assert.deepEqual(allowedTools, ["list_files", "read_file"]);
      const prompt = messages[0].content;
      const n = calls.length;
      calls.push(systemPrompt);
      let result = contract;
      if (n > 0) {
        const role = n === 1 ? "arjun-cpto" : "quinn-qa";
        assert.ok(systemPrompt.includes("Own role instructions: "+role));
        const incoming = JSON.parse(prompt.match(/Incoming artifact \(read this exact JSON\): (.+)/)[1]);
        const inputHash = prompt.match(/Exact source artifact SHA-256: ([a-f0-9]+)/)[1];
        assert.equal(inputHash, artifactDigest(incoming));
        result = output(inputHash, artifactDigest(contract));
        if (n === 2) assert.equal(incoming.contractArtifactHash, artifactDigest(contract));
        assert.ok(validateFinal(JSON.stringify(result)));
      }
      observe({type:"model.request",round:1});
      observe({type:"model.headers",round:1,httpStatus:200});
      observe({type:"model.result",round:1,finish:"stop",inputTokens:2,outputTokens:3});
      messages.push({role:"assistant",content:JSON.stringify(result)});
      emit({t:"done"});
    }
  });
  pilot.run({requestId:id,action:"save",revision:null,feedback:"Approved founder decisions"});
  pilot.run({requestId:id,action:"run",revision:1,coordinate:true});
  for(let i=0;i<150 && !["completed","failed","blocked"].includes(pilot.history(id)[0].coordination?.status);i++)
    await new Promise(r=>setTimeout(r,10));
  const r = pilot.history(id)[0];
  assert.equal(r.status,"founder-review",r.error);
  assert.equal(r.coordination.status,"completed",r.coordination.error);
  assert.equal(r.coordination.approvalState,"draft-founder-review");
  assert.equal(calls.length,3);
  const [a,q] = r.coordination.stages;
  assert.equal(a.inputArtifactHash,r.artifactHash);
  assert.equal(q.inputArtifactHash,a.artifactHash);
  assert.equal(q.sourceExecutionId,a.executionId);
  assert.notEqual(a.executionId,q.executionId);
  const es = pilot.evidence().events;
  for(const s of [a,q]) {
    assert.ok(es.some(e=>e.type==="handoff.received" && e.executionId===s.executionId && e.sourceExecutionId===s.sourceExecutionId && e.artifactHash===s.inputArtifactHash));
    assert.ok(es.some(e=>e.type==="stage.completed" && e.executionId===s.executionId && e.artifactHash===s.artifactHash));
  }
  assert.equal(es.filter(e=>e.type==="handoff.acknowledged").length,0);
  assert.equal(es.filter(e=>e.type==="coordination.completed").length,1);
});
test("wrong digest or missing provider response stops the chain without a manufactured receipt",async()=>{
  for(const wrongHash of [true,false]){
    const record={contract,executionId:randomUUID(),coordination:{status:"running",stages:[]}};
    const events=[];
    let calls=0;
    await runPlanningChain({record,persist(){},log:(type,stage,fields)=>events.push({type,...fields}),
      verified:()=>false,invoke:async({previous,observe,route})=>{
        calls++;
        route("nvidia/nemotron-3-ultra-550b-a55b","Arjun");
        if(wrongHash){observe({type:"model.headers",httpStatus:200});observe({type:"model.result"});}
        return {output:JSON.stringify(output(wrongHash?"0".repeat(64):previous.hash,artifactDigest(contract)))};
      }
    });
    assert.equal(record.coordination.status,"failed");
    assert.equal(calls,1);
    assert.ok(events.some(e=>e.type==="stage.failed"));
    assert.ok(!events.some(e=>["handoff.received","stage.completed"].includes(e.type)));
  }
});

test("recovery preserves failed evidence and reuses Arjun, retrying only Quinn",async()=>{
  const record={contract,executionId:randomUUID(),coordination:{status:"running",stages:[]}};
  const events=[], calls=[];
  const opts = {record,persist(){},log:(type,stage,fields)=>events.push({type,executionId:stage.executionId,...fields}),
    verified:s=>events.some(e=>e.type==="stage.completed" && e.executionId===s.executionId && e.artifactHash===s.artifactHash) &&
      events.some(e=>e.type==="handoff.received" && e.executionId===s.executionId && e.artifactHash===s.inputArtifactHash)};
  const model = async ({spec,previous,observe,route,validator}, fail=false) => {
    calls.push(spec.role);
    route("nvidia/nemotron-3-ultra-550b-a55b",spec.role);
    observe({type:"model.headers",httpStatus:200});
    observe({type:"model.result"});
    const artifact=output(previous.hash,artifactDigest(contract));
    if(fail && spec.role==="quinn-qa"){
      artifact.coverage[1].criterionId="AC2";
      assert.equal(validator(JSON.stringify(artifact)),false);
    }
    return {output:JSON.stringify(artifact)};
  };
  await runPlanningChain({...opts,invoke:args=>model(args,true)});
  assert.equal(record.coordination.status,"failed");
  const [arjun,failed]=record.coordination.stages;
  assert.deepEqual(failed.validationIssues,["coverage_ids"]);
  assert.ok(failed.rejectedAttempts[0].output.includes("AC2"));
  assert.ok(events.some(e=>e.type==="artifact.rejected" && e.validationIssues.includes("coverage_ids")));
  record.coordination.status="running";
  await runPlanningChain({...opts,invoke:args=>model(args)});
  assert.equal(record.coordination.status,"completed");
  assert.deepEqual(calls,["arjun-cpto","quinn-qa","quinn-qa"]);
  assert.equal(record.coordination.stages[1].status,"failed");
  assert.equal(record.coordination.stages[2].sourceExecutionId,arjun.executionId);
  assert.ok(events.some(e=>e.type==="stage.reused" && e.executionId===arjun.executionId));
});
