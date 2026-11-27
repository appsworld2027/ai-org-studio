import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRuntimeStatus, makeRuntimeObserver, makeRuntimeCheckpointStore } from "../server/runtime-status.mjs";

const issue = { labels: [{name:"ai:discovery"}] };
const repo = "example/org";
const task = { repository:repo, githubIssueNumber:3, requestId:"test", description:"must not persist" };
const receipt = (id, state, stage = "ai:discovery", mode = "standard") => ({
  id, user:{login:"github-actions[bot]",type:"Bot"},
  body:"<!-- ai-org:runtime:v1 state="+state+" stage="+stage+" run=123 attempt=1 mode="+mode+" -->\nUntrusted body",
  created_at:"2026-11-27T00:00:00Z"
});
const run = {id:123,run_attempt:1,status:"completed",conclusion:"success"};

test("exact current-stage bot receipt, with exact successful run, verifies attempt only", () => {
  const s = projectRuntimeStatus(issue,[receipt(1,"started"),receipt(2,"completed")],repo,run);
  assert.equal(s.state,"completed"); assert.equal(s.attemptVerified,true);
  assert.equal(s.runUrl,"https://github.com/example/org/actions/runs/123");
  assert.equal(s.executionVerified,undefined);
});
test("spoofed, stale stage, and non-first-line receipts are ignored", () => {
  const fake = {...receipt(4,"completed"),user:{login:"someone",type:"User"}};
  const quoted = {...receipt(5,"completed"),body:"Quoted\n"+receipt(5,"completed").body};
  assert.deepEqual(projectRuntimeStatus(issue,[fake,quoted,receipt(6,"completed","ai:qa")],repo,run),{state:"not-observed"});
});
test("mismatch, unfinished run and failed run cannot verify execution", () => {
  for (const r of [null,{...run,run_attempt:2},{...run,status:"in_progress"},{...run,conclusion:"failure"}]) {
    assert.equal(projectRuntimeStatus(issue,[receipt(1,"completed")],repo,r).attemptVerified,false);
  }
  assert.equal(projectRuntimeStatus(issue,[receipt(1,"paused")],repo,run).attemptVerified,false);
  assert.equal(projectRuntimeStatus(issue,[receipt(1,"completed","ai:discovery","readonly")],repo,run).mode,"readonly");
});
test("observer caches and projects without changing delivery state; failure explicit", async () => {
  let calls=0;
  const observe=makeRuntimeObserver({gh:async args => {
    ++calls; const p=args.at(-1);
    if(p.includes("/comments?")) return [[receipt(1,"completed")]];
    if(p.includes("/actions/runs/")) return run;
    return issue;
  }});
  const [first]=await observe([{...task,executionVerified:false}]);
  assert.equal(first.runtime.attemptVerified,true); assert.equal(first.executionVerified,false);
  await observe([task]); assert.equal(calls,3);
  const failing=makeRuntimeObserver({gh:async()=>{throw Error("unavailable")}});
  assert.equal((await failing([task]))[0].runtime.state,"unavailable");
});
test("local Garage metadata survives restart, avoids regression and excludes arbitrary content",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"runtime-checkpoint-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=makeRuntimeCheckpointStore(dir);
  await store(task,projectRuntimeStatus(issue,[receipt(2,"completed")],repo,run));
  const file=join(dir,"example__org-3.json");
  const original=await readFile(file,"utf8");
  assert.equal(JSON.parse(original).attemptVerified,true);
  assert.ok(!original.includes("must not persist")&&!original.includes("Untrusted body"));
  await makeRuntimeCheckpointStore(dir)(task,projectRuntimeStatus(issue,[receipt(1,"started")],repo,null));
  assert.equal(await readFile(file,"utf8"),original);
});

test("restarted observer shows historical local evidence during GitHub outage without marking current execution verified", async t => {
  const dir=await mkdtemp(join(tmpdir(),"runtime-outage-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const checkpoint=makeRuntimeCheckpointStore(dir);
  await checkpoint(task,projectRuntimeStatus(issue,[receipt(2,"completed")],repo,run));
  // A later unavailable run lookup must not erase the exact historical success.
  await checkpoint(task,projectRuntimeStatus(issue,[receipt(2,"completed")],repo,null));
  const restarted=makeRuntimeObserver({checkpoint:makeRuntimeCheckpointStore(dir),gh:async()=>{throw Error("offline")}});
  const [view]=await restarted([{...task,executionVerified:false}]);
  assert.equal(view.runtime.state,"unavailable");
  assert.equal(view.runtime.attemptVerified,undefined);
  assert.equal(view.runtime.lastKnown.attemptVerified,true);
  assert.equal(view.runtime.lastKnown.receiptId,2);
  assert.equal(view.executionVerified,false);
});
