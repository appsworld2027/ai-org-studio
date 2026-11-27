import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const REPO = "appsworld2027/parent-plus-ai-org";
const root = "repos/" + REPO;
const MAX = 65536;
const sha = v => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const pos = v => Number.isSafeInteger(v) && v > 0;
export function projectQualification(fixture, report, run, artifact, mainSha) {
  const fhash = createHash("sha256").update(JSON.stringify(fixture)).digest("hex");
  if (!report || !run || !artifact || report.schema !== 1 || report.fixture !== fixture.id ||
      report.version !== fixture.version || report.fixtureHash !== fhash || report.role !== fixture.role ||
      report.stage !== fixture.stage || report.repository !== REPO || report.mode !== "synthetic-readonly" ||
      !sha(report.handbookSha) || run.path !== ".github/workflows/role-qualification.yml" ||
      run.id !== artifact.workflow_run?.id || String(run.id) !== String(report.runId) ||
      String(run.run_attempt) !== String(report.attempt) || artifact.name !== "ai-org-qualification-" + run.run_attempt ||
      !/^(groq|nvidia)\//.test(report.model || "") || report.provider !== report.model.split("/")[0]) return null;
  const fields=Object.keys(fixture.expected || {});
  if (!Array.isArray(report.checks) || report.checks.length !== fields.length ||
      new Set(report.checks.map(c=>c.field)).size !== fields.length ||
      report.checks.some(c=>!fields.includes(c.field)||typeof c.passed!=="boolean")) return null;
  const checks=report.checks.filter(c=>c.passed).length;
  const pass=report.passed === true && report.objectiveChecksPassed === true && report.routeMatched === true &&
    report.exactShape === true && checks===fields.length && run.status==="completed" && run.conclusion==="success";
  const current=report.handbookSha===mainSha;
  const status=run.status!=="completed"?"in-progress":!current?"historical":pass?"passed":"failed";
  return { role:fixture.role, fixture:fixture.id, stage:fixture.stage, status, passed:pass,
    current, checks, total:fields.length, provider:report.provider, model:report.model,
    handbookSha:report.handbookSha, runId:run.id, attempt:run.run_attempt,
    runUrl:"https://github.com/"+REPO+"/actions/runs/"+run.id,
    at:run.updated_at || run.created_at || "", independentQualityAssessment:"not-assessed",
    billingStatus:"provider-billing-unverified" };
}
export function makeQualificationReader({gh, ghJson, readArtifact, clock=Date.now, ttlMs=60000}) {
  let cached, pending, at=0;
  const download=readArtifact || (async a=>{
    const dir=mkdtempSync(join(tmpdir(),"studio-qualification-"));
    try {
      await gh(["run","download",String(a.workflow_run.id),"--repo",REPO,"--name",a.name,"--dir",dir],8000);
      const path=join(dir,"qualification-result.json");
      if(statSync(path).size>MAX) throw Error("Qualification artifact too large");
      return JSON.parse(readFileSync(path,"utf8"));
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  async function fetch() {
    const head=await ghJson(root+"/commits/main");
    if(!sha(head?.sha)) throw Error("Canonical handbook revision unavailable");
    const file=await ghJson(root+"/contents/governance/ROLE_QUALIFICATION_FIXTURES.json?ref="+head.sha);
    if(typeof file?.content!=="string"||file.content.length>MAX*2) throw Error("Qualification catalog unavailable");
    const fixtures=JSON.parse(Buffer.from(file.content,"base64").toString("utf8"));
    if(!Array.isArray(fixtures)||fixtures.length>30||fixtures.length<1||new Set(fixtures.map(f=>f.role)).size!==fixtures.length) throw Error("Invalid qualification catalog");
    const result=await ghJson(root+"/actions/artifacts?per_page=100");
    const artifacts=(result?.artifacts||[]).filter(a=>/^ai-org-qualification-[1-9]\d*$/.test(a.name)&&!a.expired&&pos(a.workflow_run?.id)&&a.size_in_bytes<=MAX).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0,22);
    const found=new Map();
    let unread=0;
    // Bounded parallelism, latest valid evidence for each role only.
    for (let i=0;i<artifacts.length;i+=3) {
      const results=await Promise.allSettled(artifacts.slice(i,i+3).map(async a=>{
        const [report,run]=await Promise.all([download(a),ghJson(root+"/actions/runs/"+a.workflow_run.id)]);
        const f=fixtures.find(f=>f.id===report?.fixture);
        return f&&projectQualification(f,report,run,a,head.sha);
      }));
      for(const r of results) {
        if(r.status!=="fulfilled"||!r.value){unread++; continue;}
        if(!found.has(r.value.role))found.set(r.value.role,r.value);
      }
      if(found.size===fixtures.length)break;
    }
    return {available:true, handbookSha:head.sha, observedAt:new Date(clock()).toISOString(), unreadArtifacts:unread,
      rows:fixtures.map(f=>found.get(f.role)||{role:f.role,fixture:f.id,stage:f.stage,status:"no-evidence",passed:false}),
      kind:"synthetic-objective-screen-only"};
  }
  return async()=>{
    if(cached&&clock()-at<ttlMs)return cached;
    if(pending)return pending;
    pending=fetch().then(r=>{cached=r;at=clock();return r;}).catch(()=>cached?
      {...cached,available:false,stale:true}: {available:false,rows:[],kind:"synthetic-objective-screen-only"}).finally(()=>{pending=null;});
    return pending;
  };
}
