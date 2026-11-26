import test from "node:test";
import assert from "node:assert/strict";
import { pilotModelProfile, verifiedModels, PROBE_VERSION, ENDPOINTS, LEGACY_BUILDER, LEGACY_REVIEWER,
  splitRoute, orgRoute, fromOrgRoute, modelMatches, freeRequestFields, zeroPrice, modelFamily } from "../server/pilot-model-profile.mjs";
const glm="nvidia:z-ai/glm-5.3-flash",groq="groq:openai/gpt-oss-120b",
  deepseek="openrouter:deepseek/deepseek-v4.1-flash-1017:free",kimi="nvidia:moonshotai/kimi-k3.1-pro",
  orKimi="openrouter:moonshotai/kimi-k3.1-pro:free";
const now=Date.now();
const evidence=route=>{const {provider,model}=splitRoute(route);return {route,endpoint:ENDPOINTS[provider],
  catalogPresent:true,httpStatus:200,status:"passed",finish:"stop",reportedModel:model,sourceValid:true,
  zeroPrice:true,freeTierConfirmed:true};};
const report=(...routes)=>({version:PROBE_VERSION,complete:true,createdAt:new Date(now).toISOString(),results:routes.map(evidence)});
test("legacy routes unchanged; explicit qualified alternative requires independent model family",()=>{
  const legacy=pilotModelProfile();
  assert.equal(legacy.primary,LEGACY_BUILDER);assert.equal(legacy.review(LEGACY_BUILDER),LEGACY_REVIEWER);
  const p=pilotModelProfile({requested:"auto",report:report(glm,groq,deepseek),now,groqFree:true});
  assert.equal(p.primary,glm);assert.notEqual(modelFamily(splitRoute(p.review(glm)).model),"glm");
  assert.equal(p.alternate,deepseek);
  assert.throws(()=>pilotModelProfile({requested:kimi,report:report(kimi,orKimi),now}),/distinct model families/);
  assert.throws(()=>pilotModelProfile({requested:groq,report:report(groq,glm),now}),/not passed/);
});
test("unverified, expired and incomplete results cannot activate a route",()=>{
  const r=report(glm,groq,deepseek);
  r.results[0].reportedModel="other";
  r.results[2].zeroPrice=false;
  assert.deepEqual(verifiedModels(r,{now,groqFree:true}),[groq]);
  r.complete=false;assert.throws(()=>verifiedModels(r,{now}),/invalid/);
  r.complete=true;assert.throws(()=>verifiedModels(r,{now:now+86400001}),/expired/);
});
test("OpenRouter explicit free variant and zero-price guard; no same-family review aliases",()=>{
  assert.equal(zeroPrice({pricing:{prompt:"0",completion:"0",request:"0"}}),true);
  assert.equal(zeroPrice({pricing:{prompt:"0",completion:"0.00001"}}),false);
  assert.equal(zeroPrice({pricing:{prompt:"0"}}),false);
  assert.throws(()=>freeRequestFields("openrouter","moonshotai/kimi-k3.1-pro"),/explicit/);
  assert.deepEqual(freeRequestFields("openrouter",splitRoute(deepseek).model),{provider:{allow_fallbacks:false,max_price:{prompt:0,completion:0,request:0}}});
  for(const x of [glm,groq,deepseek,kimi])assert.equal(fromOrgRoute(orgRoute(x)),x);
  assert.equal(modelMatches(splitRoute(deepseek).model,splitRoute(deepseek).model.replace(/:free$/,""),"openrouter"),true);
});
