import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkerPolicy, workerPolicyNote } from '../server/worker-policy.mjs';
const sha = 'a'.repeat(40);
const builder = 'groq/fixture-builder';
const reviewer = 'groq/fixture-reviewer';
const policy = {execution:{defaultEngine:'free',allowedEngines:['free'],allowPaidFallback:false,
 freeModels:{builder,builderPreferred:builder,reviewer,nvidiaEvaluationBuilder:'nvidia/fixture'},
 providerPolicy:{mode:'free-only',paidFallback:false,subscriptionAuthentication:false,
 builderPreference:[builder],independentReviewer:reviewer,nvidiaReviewerEnabled:false,
 nvidiaMode:'supervised-synthetic-evaluation-only',evaluationBuilderPreference:['nvidia/fixture',builder],
 reviewerModelFamilyMustDifferFromBuilder:true}}};
function fixture(doc=policy, commit=sha) {
 const calls=[];
 const ghJson=async path=>{ calls.push(path); return path.includes('/commits/')?{sha:commit}:{encoding:'base64',content:Buffer.from(JSON.stringify(doc)).toString('base64')}; };
 return {ghJson,calls};
}
test('configured policy is bound to exact handbook revision, not a model availability claim',async()=>{
 const {ghJson,calls}=fixture();
 const p=await readWorkerPolicy({ghJson,readManifest:()=>JSON.stringify({handbook:{repo:'example/org',ref:'review/ref'}})});
 assert.deepEqual(calls,['repos/example/org/commits/review%2Fref','repos/example/org/contents/governance/AUTONOMY_POLICY.json?ref='+sha]);
 assert.equal(p.status,'configured-unverified');
 assert.equal(p.sha,sha);
 assert.deepEqual(p.builders,[builder]);
 assert.equal(p.reviewer,reviewer);
 assert.match(workerPolicyNote(p),/not verified/i);
 assert.match(workerPolicyNote(p),/example\/org/);
 assert.match(workerPolicyNote(p),new RegExp(sha));
});
test('invalid policy or missing remote evidence never substitutes local models',async()=>{
 for(const doc of [{}, {...policy,execution:{...policy.execution,allowPaidFallback:true}},
  {...policy,execution:{...policy.execution,providerPolicy:{...policy.execution.providerPolicy,independentReviewer:builder}}}]) {
  const p=await readWorkerPolicy({ghJson:fixture(doc).ghJson,readManifest:()=> '{}'});
  assert.equal(p.status,'unavailable');
  assert.equal(p.reviewer,undefined);
  assert.match(workerPolicyNote(p),/unavailable/i);
 }
 const p=await readWorkerPolicy({ghJson:async()=>{throw Error('network down')},readManifest:()=> '{}'});
 assert.equal(p.status,'unavailable');
});
test('malformed manifest is not silently treated as default handbook',async()=>{
 let requests=0;
 const p=await readWorkerPolicy({ghJson:async()=>{requests++;},readManifest:()=>'{invalid'});
 assert.equal(p.status,'unavailable'); assert.equal(requests,0);
});
test('absent manifest uses explicit default handbook, invalid commit does not load policy',async()=>{
 const {ghJson,calls}=fixture(policy,'not-a-commit');
 const p=await readWorkerPolicy({ghJson,readManifest:()=>{throw Object.assign(Error('missing'),{code:'ENOENT'})}});
 assert.deepEqual(calls,['repos/appsworld2027/parent-plus-ai-org/commits/main']);
 assert.equal(p.status,'unavailable');
});
