// Supplemental product security gate, separate from the locked Quinn suite.
// Runs only on an isolated candidate; no model calls or production files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFounderPilot } from "../server/founder-pilot.mjs";
import { createExecutionJournal } from "../server/execution-journal.mjs";

test("founder task history and evidence require current inbox membership and isolate metadata",t=>{
  const dir=mkdtempSync(join(tmpdir(),"founder-isolation-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const A="studio-pilot-001", B="founder-task-two", unknown="outside-inbox-task";
  let tasks=[A,B].map(requestId=>({requestId,title:"Synthetic test"})), calls=0;
  const config={dir,inbox:{list:()=>tasks},runner:async()=>{calls++;throw Error("Unexpected model call")}};
  const pilot=createFounderPilot(config);
  assert.deepEqual(pilot.history(A),[]);
  assert.deepEqual(pilot.history(B),[]);
  for(const id of [A,B])pilot.run({requestId:id,action:"save",revision:null,feedback:"Synthetic correction"});
  for(const id of [A,B]){
    const e=pilot.evidence(id);
    assert.equal(e.total,1);
    assert.equal(e.events.length,1);
    assert.ok(e.events.every(event=>event.requestId===id));
    assert.equal(pilot.history(id).length,1);
  }
  // A busy second task must not evict the first task's only event.
  const journal=createExecutionJournal(dir);
  for(let i=0;i<251;i++)journal.append("revision.saved",{requestId:B,revision:1,actor:"studio"});
  assert.equal(pilot.evidence(A).total,1);
  assert.equal(pilot.evidence(A).events.length,1);
  assert.equal(pilot.evidence(B).total,252);
  assert.equal(pilot.evidence(B).events.length,250);
  assert.equal(pilot.evidence(B).truncated,true);
  // An on-disk orphan record is not authorization to disclose it.
  writeFileSync(join(dir,unknown+".json"),JSON.stringify([{revision:1,status:"queued",feedback:"orphan sentinel"}]));
  for(const id of [unknown,"../invalid"]){
    assert.throws(()=>pilot.history(id));
    assert.throws(()=>pilot.evidence(id));
    assert.throws(()=>pilot.run({requestId:id,action:"save",revision:null,feedback:"denied"}));
  }
  tasks=tasks.filter(x=>x.requestId!==A);
  assert.throws(()=>pilot.history(A));
  assert.throws(()=>pilot.evidence(A));
  assert.equal(createFounderPilot(config).history(B).length,1);
  assert.equal(calls,0);
});
