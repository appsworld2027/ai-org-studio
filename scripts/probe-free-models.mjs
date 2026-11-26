// Bounded local synthetic readiness test. No product source, tools, user
// records, reasoning text or credentials in report. One request per candidate.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readStream } from "../server/agent.mjs";
import { ENDPOINTS, PROBE_VERSION, PROBE_ROUTES, DEPRECATED_CANDIDATES, splitRoute, modelMatches, zeroPrice, freeRequestFields } from "../server/pilot-model-profile.mjs";
const [keyPath,outPath]=process.argv.slice(2);
if(!keyPath||!outPath)throw Error("Usage: node scripts/probe-free-models.mjs KEY_FILE PRIVATE_REPORT");
const keys=JSON.parse(readFileSync(keyPath,"utf8"));
const groqFree=process.env.STUDIO_GROQ_FREE_ONLY==="1";
const report={version:PROBE_VERSION,createdAt:new Date().toISOString(),complete:false,results:[]};
const output=resolve(outPath);
mkdirSync(dirname(output),{recursive:true,mode:0o700});
function save(){
  writeFileSync(output+".tmp",JSON.stringify(report,null,2)+"\n",{mode:0o600});
  renameSync(output+".tmp",output);
}
const prompt='Return ONLY one JSON object with fields "values" and "source". The source must be a JavaScript function named clamp with parameters n, min, max, exported and using Math.min(max, Math.max(min, n)). In values give results for clamp(-3,0,9), clamp(4,0,9), clamp(12,0,9). No prose or tools.';
function valid(text){
  try{
    const p=JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,""));
    return JSON.stringify(p.values)==="[0,4,9]"&&String(p.source).replace(/\s+/g,"").replace(/;/g,"")==="exportfunctionclamp(n,min,max){returnMath.min(max,Math.max(min,n))}";
  }catch{return false;}
}
for(const [provider,endpoint] of Object.entries(ENDPOINTS)){
  const routes=PROBE_ROUTES.filter(id=>splitRoute(id).provider===provider);
  const key=keys[provider]?.key;
  let catalog, catalogError;
  const headers={Authorization:"Bearer "+key,"Content-Type":"application/json"};
  if(!key)catalogError="no-key";
  else if(provider==="groq"&&!groqFree)catalogError="free-tier-not-confirmed";
  else{
    try{
      const res=await fetch(endpoint+"/models",{headers,signal:AbortSignal.timeout(20000),redirect:"error"});
      if(!res.ok)catalogError="catalog-http-"+res.status;
      else catalog=new Map((await res.json()).data.map(m=>[m.id,m]));
    }catch{catalogError="catalog-unavailable";}
  }
  for(const route of routes){
    const {model}=splitRoute(route),entry=catalog?.get(model);
    const r={route,provider,model,endpoint,catalogPresent:!!entry,status:catalogError||"not-listed"};
    if(provider==="groq")r.freeTierConfirmed=groqFree;
    if(provider==="openrouter")r.zeroPrice=zeroPrice(entry);
    if(entry&&provider==="openrouter"&&(!model.endsWith(":free")||!r.zeroPrice))r.status="skipped-not-explicitly-free";
    else if(entry&&provider==="openrouter"&&model.startsWith("deepseek/")&&report.results.some(x=>x.provider==="openrouter"&&x.model.startsWith("deepseek/")&&x.status==="passed")){
      r.status="skipped-newer-deepseek-qualified";
    }else if(entry){
      const start=Date.now();r.status="failed";console.log("PROBE",route);
      try{
        const options=provider==="nvidia"&&model.startsWith("moonshotai/")?{reasoning_effort:"low"}:
          provider==="nvidia"&&model.startsWith("nvidia/nemotron-")?{chat_template_kwargs:{enable_thinking:false}}:
          provider==="groq"&&model.startsWith("openai/gpt-oss")?{reasoning_effort:"low"}:{};
        const res=await fetch(endpoint+"/chat/completions",{method:"POST",headers,redirect:"error",
          signal:AbortSignal.timeout(60000),body:JSON.stringify({model,stream:true,...(provider==="groq"?{max_completion_tokens:2500}:{max_tokens:2500}),
            messages:[{role:"user",content:prompt}],...options,...freeRequestFields(provider,model)})});
        r.httpStatus=res.status;
        if(res.ok){
          const p=await readStream(res.body);
          Object.assign(r,{reportedModel:modelMatches(model,p.reportedModel,provider)?p.reportedModel:"unverified",
            finish:p.finish,responseChars:p.text.length,reasoningChars:p.reasoningChars,
            inputTokens:p.usage?.input??null,outputTokens:p.usage?.output??null,sourceValid:valid(p.text)});
          if(modelMatches(model,p.reportedModel,provider)&&r.finish==="stop"&&r.sourceValid)r.status="passed";
        }
      }catch(e){r.errorKind=["TimeoutError","AbortError"].includes(e.name)?"timeout":"connection_error";}
      r.durationMs=Date.now()-start;
    }
    report.results.push(r);save();console.log(JSON.stringify(r));
  }
  for(const route of DEPRECATED_CANDIDATES.filter(id=>splitRoute(id).provider===provider)){
    const {model}=splitRoute(route);
    const r={route,provider,model,endpoint,catalogPresent:!!catalog?.has(model),status:"skipped-deprecated-free-endpoint"};
    report.results.push(r);console.log(JSON.stringify(r));
  }
  save();
}
report.complete=true;save();
console.log("Private qualification report saved; no generated source or key included.");
