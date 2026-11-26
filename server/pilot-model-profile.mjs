// Local supervised qualification only; no canonical AI Org routing changes.
export const ENDPOINTS = {
  nvidia:"https://integrate.api.nvidia.com/v1",
  groq:"https://api.groq.com/openai/v1",
  openrouter:"https://openrouter.ai/api/v1"
};
export const LEGACY_BUILDER = "nvidia:nvidia/nemotron-3-ultra-550b-a55b";
export const LEGACY_REVIEWER = "nvidia:mistralai/mistral-large-4-1t-a52b";
// Ordered pilot preference, not a claim of benchmark superiority.
export const NEW_CANDIDATES = [
  "nvidia:z-ai/glm-5.3-flash",
  "openrouter:deepseek/deepseek-v4.1-flash-1017:free",
  "groq:openai/gpt-oss-120b",
  "nvidia:moonshotai/kimi-k3.1-pro",
  "openrouter:deepseek/deepseek-v4-flash-0731:free",
  "openrouter:deepseek/deepseek-v4-flash:free",
  "openrouter:moonshotai/kimi-k3.1-pro:free",
  "groq:qwen/qwen3.8-27b",
  "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b",
  "groq:openai/gpt-oss-20b"
];
export const DEPRECATED_CANDIDATES = [
  "nvidia:deepseek-ai/deepseek-v4-flash",
  "nvidia:deepseek-ai/deepseek-v4-flash-0731",
  "nvidia:deepseek-ai/deepseek-v4.1-flash",
  "nvidia:moonshotai/kimi-k3"
];
export const PROBE_VERSION=2;
export const PROBE_ROUTES=[...NEW_CANDIDATES,LEGACY_REVIEWER,LEGACY_BUILDER];
export function splitRoute(route){
  const i=route.indexOf(":");
  return {provider:route.slice(0,i),model:route.slice(i+1)};
}
export function orgRoute(route){
  const {provider,model}=splitRoute(route);
  return (provider==="nvidia"?"nvidia_nim":provider)+"/"+model;
}
export function fromOrgRoute(route){
  const i=route.indexOf("/");
  const provider=route.slice(0,i);
  return (provider==="nvidia_nim"?"nvidia":provider)+":"+route.slice(i+1);
}
export function modelFamily(model){
  const id=String(model||"").toLowerCase();
  for(const name of ["deepseek","kimi","nemotron","mistral","gpt-oss","glm","qwen"]){
    if(id.includes(name))return name;
  }
  return id.replace(/:free$/,"");
}
export const routeFamily=route=>modelFamily(splitRoute(route).model);
export const stageRoute=stage=>(stage.providerId||"nvidia")+":"+stage.requestedModel;
export function modelMatches(model,reported,provider){
  return typeof reported==="string"&&
    (provider==="openrouter"?model.replace(/:free$/,"")===reported.replace(/:free$/,""):model===reported);
}
export function zeroPrice(modelEntry){
  const p=modelEntry?.pricing;
  // Missing prices are not proof of a free endpoint.
  if(!p||p.prompt==null||p.completion==null||p.prompt===""||p.completion==="")return false;
  return Object.values(p).every(v=>v!==null&&v!==""&&Number.isFinite(Number(v))&&Number(v)===0);
}
export function freeRequestFields(provider,model){
  if(provider!=="openrouter")return {};
  if(!model.endsWith(":free"))throw Error("Only explicit OpenRouter :free routes are permitted");
  return {provider:{allow_fallbacks:false,max_price:{prompt:0,completion:0,request:0}}};
}
export function verifiedModels(report,{now=Date.now(),groqFree=false}={}){
  if(report?.version!==PROBE_VERSION||report.complete!==true||!Array.isArray(report.results))throw Error("Missing or invalid local model qualification report");
  const age=now-Date.parse(report.createdAt);
  if(!Number.isFinite(age)||age<0||age>24*60*60*1000)throw Error("Qualification report expired; rerun the probe");
  return PROBE_ROUTES.filter(route=>{
    const {provider,model}=splitRoute(route);
    return report.results.some(r=>r.route===route&&r.endpoint===ENDPOINTS[provider]&&
      r.status==="passed"&&r.catalogPresent===true&&r.httpStatus===200&&r.finish==="stop"&&
      modelMatches(model,r.reportedModel,provider)&&r.sourceValid===true&&
      (provider!=="openrouter"||(model.endsWith(":free")&&r.zeroPrice===true))&&
      (provider!=="groq"||(groqFree&&r.freeTierConfirmed===true)));
  });
}
export function pilotModelProfile({requested="",report=null,now=Date.now(),groqFree=false}={}){
  if(!requested)return {primary:LEGACY_BUILDER,alternate:LEGACY_REVIEWER,
    review:builder=>builder===LEGACY_REVIEWER?LEGACY_BUILDER:LEGACY_REVIEWER,
    allowed:[LEGACY_BUILDER,LEGACY_REVIEWER],explicit:false};
  const passed=verifiedModels(report,{now,groqFree});
  const primary=requested==="auto" ? NEW_CANDIDATES.find(id=>passed.includes(id)) : requested;
  if(!primary||!passed.includes(primary))throw Error("Requested route has not passed the current free-model probe");
  const alternate=PROBE_ROUTES.find(id=>id!==primary&&routeFamily(id)!==routeFamily(primary)&&passed.includes(id));
  if(!alternate)throw Error("Need two qualified, distinct model families for independent review");
  const review=builder=>[LEGACY_REVIEWER,...NEW_CANDIDATES,LEGACY_BUILDER].find(id=>passed.includes(id)&&routeFamily(id)!==routeFamily(builder));
  return {primary,alternate,review,allowed:passed,explicit:true};
}
