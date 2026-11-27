import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeQualificationReader, projectQualification } from "../server/role-qualification.mjs";
const repo="appsworld2027/parent-plus-ai-org", main="a".repeat(40), old="b".repeat(40);
const f={id:"dev-v1",version:1,role:"dev-coder",stage:"ai:build",task:"fictional",expected:{ok:true}};
const artifact={name:"ai-org-qualification-1",workflow_run:{id:123},size_in_bytes:100,expired:false,created_at:"2026-11-27T00:00:00Z"};
const run={id:123,run_attempt:1,status:"completed",conclusion:"success",path:".github/workflows/role-qualification.yml"};
const report={schema:1,fixture:f.id,version:1,role:f.role,stage:f.stage,fixtureHash:createHash("sha256").update(JSON.stringify(f)).digest("hex"),
  repository:repo,runId:"123",attempt:"1",mode:"synthetic-readonly",handbookSha:main,provider:"nvidia",model:"nvidia/example",
  checks:[{field:"ok",passed:true}],exactShape:true,routeMatched:true,objectiveChecksPassed:true,passed:true};
test("exact current run, fixture fingerprint and artifact verify objective screen only",()=>{
  const q=projectQualification(f,report,run,artifact,main);
  assert.equal(q.status,"passed");assert.equal(q.checks,1);assert.equal(q.independentQualityAssessment,"not-assessed");
  assert.equal(q.runUrl,"https://github.com/"+repo+"/actions/runs/123");
});
test("incorrect identity, attempt, workflow, provider, fixture or incomplete run never passes",()=>{
  for(const r of [{...report,fixtureHash:"bad"},{...report,runId:"124"},{...report,attempt:"2"},{...report,provider:"groq"},{...report,checks:[{field:"wrong",passed:true}]}])assert.equal(projectQualification(f,r,run,artifact,main),null);
  assert.equal(projectQualification(f,report,{...run,path:"other"},artifact,main),null);
  assert.equal(projectQualification(f,report,{...run,conclusion:"failure"},artifact,main).status,"failed");
  assert.equal(projectQualification(f,report,{...run,status:"in_progress"},artifact,main).status,"in-progress");
  assert.equal(projectQualification(f,{...report,handbookSha:old},run,artifact,main).status,"historical");
});
test("reader retrieves the canonical catalog, caches and marks missing or unavailable evidence",async()=>{
  let calls=0, now=0, down=false;
  const read=makeQualificationReader({clock:()=>now,ttlMs:100,readArtifact:async()=>report,ghJson:async p=>{
    ++calls;if(down)throw Error("offline");
    if(p.endsWith("/commits/main"))return {sha:main};
    if(p.includes("/contents/"))return {content:Buffer.from(JSON.stringify([f,{...f,id:"other-v1",role:"other-role"}])).toString("base64")};
    if(p.includes("/artifacts?"))return {artifacts:[artifact]};
    return run;
  }});
  const first=await read();assert.equal(first.rows[0].status,"passed");assert.equal(first.rows[1].status,"no-evidence");
  await read();assert.equal(calls,4);now=101;down=true;
  const stale=await read();assert.equal(stale.available,false);assert.equal(stale.stale,true);
});
