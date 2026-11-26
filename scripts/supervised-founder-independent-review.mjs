// Read-only, independently modeled review of an isolated candidate.
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {runTurn} from "../server/agent.mjs";
import {PROVIDERS} from "../server/providers.mjs";
import {parseDeliveryResponse} from "./delivery-response.mjs";
const [candidate,keyFile,role,priorHash,out]=process.argv.slice(2);
if(!candidate||!keyFile||!["quinn-qa","rex-reviewer"].includes(role)||!/^[a-f0-9]{64}$/.test(priorHash||"")||!out)throw Error("Invalid independent review invocation");
const key=JSON.parse(readFileSync(keyFile,"utf8")).nvidia?.key;
if(typeof key!=="string"||!key)throw Error("Qualified free reviewer credential unavailable");
const paths=["server/founder-pilot.mjs","server/server.mjs","public/founder-inbox.js","test/founder-inbox-revisions-v2.test.mjs"];
const files=paths.map(path=>({path,sha256:createHash("sha256").update(readFileSync(candidate+"/"+path)).digest("hex"),source:readFileSync(candidate+"/"+path,"utf8")}));
const base=candidate.replace(/\/candidate$/, "/baseline");
const excerpts=files.map(f=>{
  if(f.path.startsWith("test/"))return f.source;
  const diff=spawnSync("git",["diff","--no-index","--",base+"/"+f.path,candidate+"/"+f.path],{encoding:"utf8",maxBuffer:1024*1024});
  if(diff.status!==1)throw Error("Could not generate actual source diff for "+f.path);
  return diff.stdout;
});
const prompt="Independent "+role+" review. Builder was Groq openai/gpt-oss-120b; you are a distinct free Nemotron family. Actual source diffs and full revised acceptance suite follow, with final-file SHA256 hashes. All four revised acceptance tests, founder-pilot tests and inbox tests passed. Review task isolation, explicit-save/no-auto-run, journal evidence, restart history, queued revisions during active run, authorization, UI, and test quality. Report APPROVE only if no must-fix; otherwise CHANGES with specific findings. Cite only source and tests you can see. Do not claim runtime journal events you have not seen. In particular, contract.reviewed is not a journal event. Do not claim browser tests or other runs. Return only JSON receipt with inputArtifactHash exactly "+priorHash+", verdict APPROVE or CHANGES, and specific factual summary.\n"+files.map((f,i)=>"\nFILE "+f.path+" SHA256 "+f.sha256+"\n"+excerpts[i]).join("\n");
const messages=[{role:"user",content:prompt}];let done=false,reportedModel,finish,inputTokens,outputTokens,httpOk=false;
await runTurn({messages,provider:{...PROVIDERS.nvidia,id:"nvidia",key},model:"nvidia/nemotron-3-ultra-550b-a55b",root:candidate,
  systemPrompt:"You are an independent AI Org reviewer. Read the supplied source only. No tools, source edits, deployment, or credentials.",
  allowedTools:[],freeOnly:true,directGeneration:true,auto:false,maxRounds:1,maxTokens:2500,signal:AbortSignal.timeout(180000),
  observe(e){if(e.type==="model.headers")httpOk=e.httpStatus===200;if(e.type==="model.result"){reportedModel=e.reportedModel;finish=e.finish;inputTokens=e.inputTokens;outputTokens=e.outputTokens;}},
  emit(e){if(e.t==="done")done=true;if(e.t==="error")throw Error(e.message);}});
if(!done||!httpOk||finish!=="stop"||reportedModel!=="nvidia/nemotron-3-ultra-550b-a55b")throw Error("Reviewer model identity/completion unverified: "+JSON.stringify({done,httpOk,finish,reportedModel,inputTokens,outputTokens}));
const parsed=parseDeliveryResponse(messages.at(-1)?.content,priorHash);
if(!parsed.receipt)throw Error("Invalid independent review receipt: "+parsed.issues.join(","));
writeFileSync(out,JSON.stringify({role,requestedModel:"nvidia/nemotron-3-ultra-550b-a55b",reportedModel,inputTokens,outputTokens,files:files.map(({path,sha256})=>({path,sha256})),receipt:parsed.receipt},null,2),{mode:0o600,flag:"wx"});
console.log(JSON.stringify({role,model:reportedModel,inputTokens,outputTokens,verdict:parsed.receipt.verdict,output:out}));
