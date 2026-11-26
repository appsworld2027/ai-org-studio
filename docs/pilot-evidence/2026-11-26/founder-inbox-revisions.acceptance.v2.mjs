import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createFounderPilot} from "../server/founder-pilot.mjs";
import {artifactDigest} from "../server/execution-journal.mjs";
const A="studio-pilot-001",B="founder-task-two";
const contract={summary:"Mock contract",acceptanceCriteria:["Save feedback","Keep history"],edgeCases:["Timeout"],openQuestions:[]};
function fixture(t,hold=false){
 const root=mkdtempSync(join(tmpdir(),"founder-accept-")),orgDir=join(root,"org"),dir=join(root,"history");
 for(const d of ["scripts","org/agents","playbooks"])mkdirSync(join(orgDir,d),{recursive:true});
 writeFileSync(join(orgDir,"scripts/agent-router.mjs"),'export const route=()=>({action:"run",engine:"free",role:"maya-ai-pm",free_model:"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"});export const agentInfo=()=>({name:"Maya"});');
 writeFileSync(join(orgDir,"org/agents/maya-ai-pm.md"),"role");writeFileSync(join(orgDir,"playbooks/ai-pm.md"),"playbook");
 const keyFile=join(root,"key.json");writeFileSync(keyFile,'{"nvidia":{"key":"mock-only"}}');
 let calls=0,release=()=>{};const gate=hold?new Promise(r=>release=r):Promise.resolve();
 const config={dir,root,orgDir,keyFile,inbox:{list:()=>[A,B].map(requestId=>({requestId,title:requestId,description:"Synthetic"}))},runner:async({messages,emit,observe})=>{
   calls++;await gate;observe({type:"model.request",round:1});observe({type:"model.headers",httpStatus:200,round:1});observe({type:"model.result",round:1,finish:"stop"});messages.push({role:"assistant",content:JSON.stringify(contract)});emit({t:"done"});
 }};
 const pilot=createFounderPilot(config);t.after(async()=>{release();await new Promise(r=>setTimeout(r,50));rmSync(root,{recursive:true,force:true});});
 return {pilot,config,release,get calls(){return calls;}};
}
const act=(p,id,action,revision=null,feedback)=>p.run({requestId:id,action,revision,...(feedback===undefined?{}:{feedback})});
async function waitFor(p,id,n,status){for(let i=0;i<200;i++){const r=p.history(id).find(x=>x.revision===n);if(r?.status===status)return r;await new Promise(r=>setTimeout(r,10));}assert.fail("Timed out: "+status);}
test("AC-01 save is isolated, validated, idempotent and never starts a model",t=>{
 const f=fixture(t),p=f.pilot,a=act(p,A,"save",null,"x".repeat(500)),b=act(p,B,"save",null,"feedback B");
 assert.equal(a.revision,1);assert.equal(a.parentRevision,null);assert.equal(a.status,"queued");assert.equal(a.baseContract,null);
 assert.equal(b.revision,1);assert.deepEqual(act(p,B,"save",null,"feedback B"),b);
 assert.equal(p.history(A).length,1);assert.equal(p.history(B).length,1);assert.equal(f.calls,0);
 assert.throws(()=>act(p,A,"save",1,""),/correction/i);assert.throws(()=>act(p,A,"save",1,"x".repeat(2001)),/correction/i);
 assert.throws(()=>act(p,"unknown-task","save",null,"bad"));assert.equal(p.evidence(A).events.filter(e=>e.type==="model.request").length,0);
});
test("AC-02 explicit run and acceptance acknowledge exact contract and preserve history",async t=>{
 const f=fixture(t),p=f.pilot;act(p,A,"save",null,"initial feedback");assert.equal(f.calls,0);
 assert.equal(act(p,A,"run",1).status,"running");const reviewed=await waitFor(p,A,1,"founder-review");
 assert.deepEqual(reviewed.contract,contract);assert.equal(act(p,A,"accept",1).status,"contract-accepted");
 const ack=p.evidence(A).events.find(e=>e.type==="handoff.acknowledged"&&e.revision===1);
 assert.equal(ack?.artifactHash,artifactDigest(contract));assert.equal(ack?.actor,"founder");
 const next=act(p,A,"save",1,"correction feedback");assert.equal(next.revision,2);assert.equal(next.parentRevision,1);
 assert.equal(p.history(A)[0].status,"contract-accepted");assert.equal(f.calls,1);
});
test("AC-03 save during work queues next revision without auto-launch",async t=>{
 const f=fixture(t,true),p=f.pilot;act(p,A,"save",null,"first");act(p,A,"run",1);await waitFor(p,A,1,"running");
 for(let i=0;i<100&&f.calls===0;i++)await new Promise(r=>setTimeout(r,10));
 const q=act(p,A,"save",1,"second");assert.equal(q.revision,2);assert.equal(q.parentRevision,1);assert.equal(q.status,"queued");
 assert.equal(f.calls,1);assert.throws(()=>act(p,A,"run",2),/working/);f.release();
 await waitFor(p,A,1,"founder-review");assert.equal(p.history(A)[1].status,"queued");assert.equal(f.calls,1);
 act(p,A,"run",2);await waitFor(p,A,2,"founder-review");assert.equal(f.calls,2);assert.equal(p.history(A)[0].status,"founder-review");
});
test("AC-04 chronology, metadata and task isolation survive restart",async t=>{
 const f=fixture(t),p=f.pilot;act(p,A,"save",null,"first");act(p,A,"run",1);await waitFor(p,A,1,"founder-review");act(p,A,"accept",1);
 act(p,A,"save",1,"second");act(p,A,"run",2);await waitFor(p,A,2,"founder-review");act(p,A,"save",2,"third");
 const h=p.history(A);assert.deepEqual(h.map(r=>r.revision),[1,2,3]);assert.deepEqual(h.map(r=>r.status),["contract-accepted","founder-review","queued"]);
 assert.ok(h.every(r=>typeof r.createdAt==="string"&&r.feedback));assert.equal(f.calls,2);assert.equal(p.history(B).length,0);
 const restarted=createFounderPilot(f.config);assert.deepEqual(restarted.history(A).map(r=>r.revision),[1,2,3]);
 assert.equal(restarted.history(A)[0].status,"contract-accepted");assert.ok(restarted.evidence(A).events.every(e=>e.requestId===A));
});
