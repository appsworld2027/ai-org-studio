import test, { after } from "node:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimDispatch, dispatchFingerprint } from "../server/dispatch-fence.mjs";
import assert from "node:assert/strict";
import { createGithubTaskAdapter as baseAdapter } from "../server/github-task-adapter.mjs";
const scratch=mkdtempSync(join(tmpdir(),"studio-dispatch-test-"));
let sequence=0;
const newDir=()=>join(scratch,"claim-"+(++sequence));
const createGithubTaskAdapter=options=>baseAdapter({claimDir:newDir(),...options});
after(()=>rmSync(scratch,{recursive:true,force:true}));


const PARENT_REPO = "appsworld2027/Parent-plus-";
const requestId = "request_12345678";
const url = "https://github.com/appsworld2027/Parent-plus-/issues/44";

test("creates an allowlisted GitHub issue and reuses it on retry", async () => {
  const calls = [];
  const issues = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === "api" && args[1] === `repos/${PARENT_REPO}`) return { full_name: PARENT_REPO, private: true };
    if (args[1] === "--paginate") return [[...issues]];
    if (args[1] === "--method" && args[2] === "POST") {
      const field = name => {
        const index = args.findIndex((value, i) => value === "-f" && args[i + 1]?.startsWith(name + "="));
        return index >= 0 ? args[index + 1].slice(name.length + 1) : undefined;
      };
      const body = field("body");
      const title = field("title");
      const issue = { number: 44, state: "open", html_url: url, body, title, labels:[{name:"ai:discovery"}] };
      issues.push(issue);
      return issue;
    }
    throw new Error("Unexpected gh invocation: " + args.join(" "));
  };
  const adapter = createGithubTaskAdapter({ run, allowedRepositories: [PARENT_REPO] });
  const payload = {
    repository: PARENT_REPO,
    requestId,
    title: "Improve registration",
    body: `<!-- studio-request:${requestId} -->\nFounder request`,
    labels: ["ai:discovery"]
  };

  const first = await adapter.ensureTask(payload);
  const second = await adapter.ensureTask(payload);

  assert.deepEqual(first, { number: 44, state: "open", url });
  assert.deepEqual(second, first);
  assert.equal(calls.filter(args => args[1] === "--method").length, 1);
  assert.ok(calls.some(args => args.includes("labels[]=ai:discovery")));
});

test("GitHub repository allowlists match case-insensitively", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO.toLowerCase()],
    run: async () => ({ full_name: PARENT_REPO, private: true })
  });
  assert.deepEqual(await adapter.getRepository({ repository: PARENT_REPO }), { fullName: PARENT_REPO, private: true });
});

test("getRepository verifies canonical repository identity and privacy", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async args => {
      assert.deepEqual(args, ["api", `repos/${PARENT_REPO}`]);
      return { full_name: PARENT_REPO, private: true };
    }
  });
  assert.deepEqual(await adapter.getRepository({ repository: PARENT_REPO }), { fullName: PARENT_REPO, private: true });
});

test("getRepository rejects an unverified repository identity", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => ({ full_name: "appsworld2027/other", private: true })
  });
  await assert.rejects(adapter.getRepository({ repository: PARENT_REPO }), /did not confirm product repository identity/);
});

test("findTask returns null when no request marker exists", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  assert.equal(await adapter.findTask({ repository: PARENT_REPO, requestId }), null);
});

test("rejects repositories outside the allowlist", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  await assert.rejects(
    adapter.findTask({ repository: "appsworld2027/ai-org-studio", requestId }),
    /not allowlisted/
  );
});

test("rejects duplicate markers rather than silently selecting one", async () => {
  const marker = `<!-- studio-request:${requestId} -->`;
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[
      { number: 1, state: "open", html_url: url, body: marker },
      { number: 2, state: "open", html_url: url, body: marker }
    ]]
  });
  await assert.rejects(
    adapter.findTask({ repository: PARENT_REPO, requestId }),
    /Duplicate GitHub tasks detected/
  );
});

test("rejects invalid labels and request IDs", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  await assert.rejects(
    adapter.ensureTask({ repository: PARENT_REPO, requestId: "bad", title: "x", body: "y", labels: ["ai:discovery"] }),
    /Invalid request ID/
  );
  await assert.rejects(
    adapter.ensureTask({ repository: PARENT_REPO, requestId, title: "x", body: "y", labels: ["engine:paid"] }),
    /Invalid GitHub task payload/
  );
});

const request = () => ({
  repository: PARENT_REPO, requestId, title: "Fictional qualification",
  body: `<!-- studio-request:${requestId} -->\nSynthetic only`, labels:["ai:discovery"]
});

function taskFixture({ responseLost = false, unresolved = false, labelMissing = false } = {}) {
  let posts=0, lookups=0, issues=[];
  const claimDir=newDir();
  const run=async args => {
      if (args[1]==="--paginate") { lookups++; await new Promise(r=>setTimeout(r,10)); return [[...issues]]; }
      if (args[1]==="--method" && args[2]==="POST") {
        posts++;
        const input = request();
        if (!unresolved) issues.push({number:44,state:"open",html_url:url,title:input.title,body:input.body,labels:labelMissing?[]:[{name:"ai:discovery"}]});
        if (responseLost || unresolved) throw new Error("simulated response loss");
        return issues[0];
      }
      throw new Error("unexpected operation");
  };
  const newAdapter=()=>baseAdapter({allowedRepositories:[PARENT_REPO],claimDir,run});
  return {adapter:newAdapter(),newAdapter,claimDir,clearRemote:()=>{issues=[]},counts:()=>({posts,lookups})};
}

test("concurrent same request submissions share one GitHub POST", async () => {
  const {adapter,counts}=taskFixture();
  const outputs=await Promise.all(Array.from({length:12},()=>adapter.ensureTask(request())));
  assert.equal(new Set(outputs.map(x=>x.number)).size,1);
  assert.equal(counts().posts,1);
});

test("conflicting concurrent request ID reuse fails closed", async () => {
  const {adapter,counts}=taskFixture();
  const pending=adapter.ensureTask(request());
  await assert.rejects(adapter.ensureTask({...request(),title:"Different request"}),/Conflicting request ID/);
  await pending;
  await assert.rejects(adapter.ensureTask({...request(),body:request().body+" changed"}),/Conflicting request ID/);
  assert.equal(counts().posts,1);
});

test("response lost after GitHub created task reconciles same marker", async () => {
  const {adapter,counts}=taskFixture({responseLost:true});
  const result=await adapter.ensureTask(request());
  assert.equal(result.number,44);
  assert.equal((await adapter.ensureTask(request())).number,44);
  assert.equal(counts().posts,1);
});

test("ambiguous POST with no visible issue is not retried in same adapter", async () => {
  const {adapter,counts}=taskFixture({unresolved:true});
  await assert.rejects(adapter.ensureTask(request()),/outcome uncertain/);
  await assert.rejects(adapter.ensureTask(request()),/outcome uncertain/);
  assert.equal(counts().posts,1);
});

test("task must start with the exact idempotency marker", async () => {
  const {adapter,counts}=taskFixture();
  await assert.rejects(adapter.ensureTask({...request(),body:"missing marker"}),/exact request marker/);
  assert.equal(counts().posts,0);
  assert.equal(counts().lookups,0);
});

test("task without a confirmed stage is not submitted or duplicated", async () => {
  const {adapter,counts}=taskFixture({labelMissing:true});
  await assert.rejects(adapter.ensureTask(request()),/no confirmed AI Org stage/);
  await assert.rejects(adapter.ensureTask(request()),/no confirmed AI Org stage/);
  assert.equal(counts().posts,1);
});

test("two independent adapter instances sharing a fence cannot duplicate a POST", async () => {
  const {adapter,newAdapter,counts}=taskFixture();
  const results=await Promise.allSettled([adapter.ensureTask(request()),newAdapter().ensureTask(request())]);
  assert.ok(results.some(x=>x.status==="fulfilled"));
  assert.equal(counts().posts,1);
  assert.equal((await newAdapter().ensureTask(request())).number,44);
  assert.equal(counts().posts,1);
});

test("ambiguous POST stays held across a controller restart", async () => {
  const {adapter,newAdapter,counts}=taskFixture({unresolved:true});
  await assert.rejects(adapter.ensureTask(request()),/outcome uncertain/);
  await assert.rejects(newAdapter().ensureTask(request()),/outcome uncertain/);
  await assert.rejects(newAdapter().ensureTask({...request(),title:"Conflict"}),/Conflicting request ID/);
  assert.equal(counts().posts,1);
});

test("confirmed task is not recreated if a later lookup loses it", async () => {
  const {adapter,newAdapter,counts,clearRemote}=taskFixture();
  await adapter.ensureTask(request());clearRemote();
  await assert.rejects(newAdapter().ensureTask(request()),/outcome uncertain/);
  assert.equal(counts().posts,1);
});

test("missing durable storage fails closed before remote mutation", async () => {
  let calls=0;
  const adapter=baseAdapter({allowedRepositories:[PARENT_REPO],run:async()=>{calls++;return [[]]}});
  await assert.rejects(adapter.ensureTask(request()),/Durable dispatch fence unavailable/);
  assert.equal(calls,0);
});

test("corrupt fence holds rather than permitting a repeat POST", async () => {
  const {adapter,newAdapter,claimDir,counts}=taskFixture({unresolved:true});
  await assert.rejects(adapter.ensureTask(request()),/outcome uncertain/);
  const [name]=readdirSync(claimDir);
  writeFileSync(join(claimDir,name),"incomplete");
  await assert.rejects(newAdapter().ensureTask(request()),/outcome uncertain/);
  assert.equal(counts().posts,1);
});

test("symlinked fence directories and claim files fail closed", async () => {
  const target=newDir(),alias=newDir();mkdirSync(target,{mode:0o700});symlinkSync(target,alias);
  const req=request(),fp=dispatchFingerprint(req.title,req.body,req.labels);
  assert.throws(()=>claimDispatch(alias,req.repository,req.requestId,fp),/not private/);
  assert.equal(claimDispatch(target,req.repository,req.requestId,fp),true);
  const [name]=readdirSync(target);
  const other=newDir();mkdirSync(other,{mode:0o700});
  symlinkSync(join(target,name),join(other,name));
  assert.throws(()=>claimDispatch(other,req.repository,req.requestId,fp),/outcome uncertain/);
});

test("independent OS processes can claim a shared request exactly once", async () => {
  const dir=newDir(),fp="a".repeat(64),module=new URL("../server/dispatch-fence.mjs",import.meta.url).href;
  const script='import {claimDispatch} from '+JSON.stringify(module)+'; try { console.log(claimDispatch(process.argv[1],"example/demo","request_123",process.argv[2])?"won":"held") } catch(e){console.log("held")}';
  const exec=promisify(execFile);
  const results=await Promise.all(Array.from({length:8},()=>exec(process.execPath,["--input-type=module","-e",script,dir,fp])));
  assert.equal(results.filter(x=>x.stdout.trim()==="won").length,1);
  assert.equal(claimDispatch(dir,"example/demo","request_123",fp),false);
});
