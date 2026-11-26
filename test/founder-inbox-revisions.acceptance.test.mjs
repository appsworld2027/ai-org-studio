import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createFounderPilot} from "../server/founder-pilot.mjs";
const A="studio-pilot-001", B="founder-task-two";
const contract={summary:"Mock contract",acceptanceCriteria:["Save feedback","Keep history"],edgeCases:["Timeout"],openQuestions:[]};
function fixture(t,{hold=false}={}){
  const root=mkdtempSync(join(tmpdir(),"founder-tests-")), orgDir=join(root,"org"), dir=join(root,"history");
  for(const d of ["scripts","org/agents","playbooks"])mkdirSync(join(orgDir,d),{recursive:true});
  writeFileSync(join(orgDir,"scripts/agent-router.mjs"),'export const route=()=>({action:"run",engine:"free",role:"maya-ai-pm",free_model:"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"});export const agentInfo=()=>({name:"Maya"});');
  writeFileSync(join(orgDir,"org/agents/maya-ai-pm.md"),"role");
  writeFileSync(join(orgDir,"playbooks/ai-pm.md"),"playbook");
  const keyFile=join(root,"key.json");writeFileSync(keyFile,'{"nvidia":{"key":"mock-only"}}');
  let calls=0, release=()=>{};
  const gate=hold?new Promise(r=>{release=r;}):Promise.resolve();
  const config={dir,root,orgDir,keyFile,inbox:{list:()=>[A,B].map(requestId=>({requestId,title:"Task "+requestId,description:"Test feedback"}))},
    runner:async({messages,emit,observe})=>{
      calls++;await gate;observe({type:"model.request",round:1});observe({type:"model.headers",httpStatus:200,round:1});
      observe({type:"model.result",round:1,finish:"stop"});messages.push({role:"assistant",content:JSON.stringify(contract)});emit({t:"done"});
    }};
  const pilot=createFounderPilot(config);
  t.after(async()=>{release();await new Promise(r=>setTimeout(r,50));rmSync(root,{recursive:true,force:true});});
  return {pilot,config,dir,release,get calls(){return calls;}};
}
function act(pilot,requestId,action,revision=null,feedback){return pilot.run({requestId,action,revision,...(feedback===undefined?{}:{feedback})});}
async function waitFor(pilot,requestId,revision,status){
  for(let i=0;i<200;i++){const r=pilot.history(requestId).find(r=>r.revision===revision);if(r?.status===status)return r;await new Promise(r=>setTimeout(r,10));}
  assert.fail("Timed out waiting for "+status);
}

test("AC-01 save feedback creates queued revision with parent link, validates length, idempotent, held-run isolated, history recovers", async (t) => {
  const f = fixture(t);
  const {pilot, config} = f;

  // Save on task A (no prior revisions)
  const savedA = act(pilot, A, "save", null, "x".repeat(500));
  assert.equal(savedA.revision, 1);
  assert.equal(savedA.parentRevision, null);
  assert.equal(savedA.status, "queued");
  assert.equal(savedA.feedback, "x".repeat(500));

  // Save on task B
  const savedB = act(pilot, B, "save", null, "feedback on B");
  assert.equal(savedB.revision, 1);
  assert.equal(savedB.parentRevision, null);
  assert.equal(f.calls, 0);
  assert.equal(pilot.history(B).length, 1);

  // Validation limits
  assert.throws(() => act(pilot, A, "save", savedA.revision, ""), /1[–-]2000/);
  assert.throws(() => act(pilot, A, "save", savedA.revision, "x".repeat(2001)), /1[–-]2000/);

  // Idempotency: same feedback returns same revision
  const again = act(pilot, A, "save", null, "x".repeat(500));
  assert.equal(again.revision, 1);

  // Held run: start run, wait for model call, save correction while held, count unchanged
  const held = fixture(t, {hold: true});
  const {pilot: hp, release} = held;
  const heldSaved = act(hp, A, "save", null, "held initial feedback");
  act(hp, A, "run", heldSaved.revision);
  for (let i = 0; i < 100 && held.calls === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert(held.calls > 0);
  const preCalls = held.calls;
  act(hp, A, "save", heldSaved.revision, "correction during run");
  assert.equal(held.calls, preCalls);
  release();
  await waitFor(hp, A, 1, "founder-review");

  // Recovery: new pilot instance recovers history
  const pilot2 = createFounderPilot(held.config);
  const hist = pilot2.history(A);
  assert.equal(hist.length, 2); // original save + correction
  assert.equal(hist[0].revision, 1);
  assert.equal(hist[1].revision, 2);
  assert.equal(hist[1].parentRevision, 1);

  // Evidence offer/ack hash matching
  const ev = pilot2.evidence(A);
  const offer = ev.events.find(e => e.type === "handoff.offered" && e.revision === 1);
  assert.ok(offer, "completed revision has real handoff");
  assert.equal(offer.artifactHash, hist[0].artifactHash);
  assert.ok(ev.events.every(e => e.requestId === A));
});

test("AC-02 founder accepts revision with zero openQuestions -> contract-accepted, journal ack, correction forks", async (t) => {
  const f = fixture(t);
  const {pilot, config} = f;
  
  const saved = act(pilot, A, "save", null, "initial feedback");
  assert.equal(saved.revision, 1);
  assert.equal(saved.parentRevision, null);
  
  act(pilot, A, "run", saved.revision);
  const reviewed = await waitFor(pilot, A, saved.revision, "founder-review");
  assert.equal(reviewed.status, "founder-review");
  assert.ok(reviewed.contract);
  assert.equal(reviewed.contract.openQuestions.length, 0);
  
  const accepted = act(pilot, A, "accept", reviewed.revision);
  assert.equal(accepted.status, "contract-accepted");
  assert.ok(accepted.acceptedAt);
  
  const events = pilot.evidence(A).events;
  const ack = events.find(e => e.type === "handoff.acknowledged");
  assert.ok(ack, "handoff.acknowledged event missing");
  const offer = events.find(e => e.type === "handoff.offered" && e.revision === reviewed.revision && e.executionId === ack.executionId);
  assert.ok(offer, "matching offer missing");
  assert.equal(ack.artifactHash, offer.artifactHash, "ack/offer hash mismatch");
  assert.equal(ack.artifactHash, reviewed.artifactHash);
  
  const correction = act(pilot, A, "save", accepted.revision, "correction feedback");
  assert.equal(correction.revision, 2);
  assert.equal(correction.parentRevision, 1);
  
  const history = pilot.history(A);
  const rev1 = history.find(r => r.revision === 1);
  assert.equal(rev1.status, "contract-accepted");
  assert.ok(rev1.acceptedAt);
  
  const pilot2 = createFounderPilot(config);
  const history2 = pilot2.history(A);
  const rev1b = history2.find(r => r.revision === 1);
  assert.equal(rev1b.status, "contract-accepted");
  assert.ok(rev1b.acceptedAt);
});

test("AC-03 queued revision created when saving feedback during running revision", async (t) => {
  const f = fixture(t, { hold: true });
  const { pilot, release } = f;
  const saved = act(pilot, A, "save", null, "initial direction");
  const rev0 = act(pilot, A, "run", saved.revision);
  assert.equal(rev0.revision, 1);
  assert.equal(rev0.parentRevision, null);
  assert.equal(rev0.status, "running");
  for (let i = 0; i < 200; i++) {
    if (f.calls > 0) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(f.calls > 0);
  const rev1 = act(pilot, A, "save", rev0.revision, "new direction");
  assert.equal(rev1.revision, 2);
  assert.equal(rev1.parentRevision, 1);
  assert.equal(rev1.status, "queued");
  assert.equal(rev1.feedback, "new direction");
  assert.equal(f.calls, 1);
  release();
  const completed = await waitFor(pilot, A, 1, "founder-review");
  assert.equal(completed.status, "founder-review");
  const history = pilot.history(A);
  assert.equal(history.length, 2);
  assert.equal(history[0].revision, 1);
  assert.equal(history[0].status, "founder-review");
  assert.equal(history[1].revision, 2);
  assert.equal(history[1].parentRevision, 1);
  assert.equal(history[1].status, "queued");
  const events = pilot.evidence(A).events;
  assert.ok(Array.isArray(events));
  assert.equal(f.calls, 1);
  act(pilot, A, "run", rev1.revision);
  await waitFor(pilot, A, rev1.revision, "founder-review");
  assert.equal(f.calls, 2);
  assert.equal(pilot.history(A)[0].artifactHash, completed.artifactHash);
});

test("AC-04: history shows revisions chronologically with metadata and latest by default", async (t) => {
  const f = fixture(t);
  const { pilot } = f;

  const rev1Save = act(pilot, A, "save", null, "Initial feedback");
  assert.equal(rev1Save.revision, 1);
  assert.equal(rev1Save.parentRevision, null);
  act(pilot, A, "run", rev1Save.revision);
  await waitFor(pilot, A, rev1Save.revision, "founder-review");
  act(pilot, A, "accept", rev1Save.revision);

  const rev2Save = act(pilot, A, "save", rev1Save.revision, "Correction one");
  assert.equal(rev2Save.revision, 2);
  assert.equal(rev2Save.parentRevision, 1);
  act(pilot, A, "run", rev2Save.revision);
  await waitFor(pilot, A, rev2Save.revision, "founder-review");
  act(pilot, A, "accept", rev2Save.revision);

  const rev3Save = act(pilot, A, "save", rev2Save.revision, "Correction two");
  assert.equal(rev3Save.revision, 3);
  assert.equal(rev3Save.parentRevision, 2);

  const history = pilot.history(A);
  assert.equal(history.length, 3);
  assert.equal(history[0].revision, 1);
  assert.equal(history[1].revision, 2);
  assert.equal(history[2].revision, 3);
  assert.ok(history[0].createdAt);
  assert.ok(history[1].createdAt);
  assert.ok(history[2].createdAt);
  assert.ok(history[0].contract?.summary);
  assert.ok(history[1].contract?.summary);
  assert.equal(history[2].status, "queued");

  const evidence = pilot.evidence(A);
  for (const r of history.slice(0,2)) {
    const offer = evidence.events.find(e => e.type === "handoff.offered" && e.revision === r.revision && e.executionId === r.executionId);
    const ack = evidence.events.find(e => e.type === "handoff.acknowledged" && e.revision === r.revision && e.executionId === r.executionId);
    assert.ok(offer && ack, "missing recorded offer/ack");
    assert.equal(offer.artifactHash, ack.artifactHash);
    assert.equal(ack.artifactHash, r.artifactHash);
  }

  const pilot2 = createFounderPilot(f.config);
  const history2 = pilot2.history(A);
  assert.equal(history2.length, 3);
  assert.equal(history2[0].revision, 1);
  assert.equal(history2[2].revision, 3);
});
