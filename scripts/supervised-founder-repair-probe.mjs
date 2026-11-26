// One bounded, same-builder repair proposal. Writes no product source.
import {readFileSync,writeFileSync} from "node:fs";
import {runTurn} from "../server/agent.mjs";
import {PROVIDERS} from "../server/providers.mjs";
const [candidate,keyFile,out,feedback=""]=process.argv.slice(2);
if(!candidate||!keyFile||!out)throw Error("candidate keyfile output required");
const key=JSON.parse(readFileSync(keyFile,"utf8")).groq?.key;
if(typeof key!=="string"||!key)throw Error("Free Groq credential unavailable");
const source=readFileSync(candidate+"/server/founder-pilot.mjs","utf8");
const facade=source.slice(source.indexOf("    // Synchronous history lookup"),source.indexOf("  };\n}\n\n// Private factory"));
const privateHistory=source.slice(source.indexOf("  function history(id) {"),source.indexOf("  // Shared live revisions array"));
const messages=[{role:"user",content:"Repair two independently verified defects in this synthetic candidate. Do not change public signatures, request validation, journaling, security or model routing. Return ONLY JSON with keys facadeHistory and privateHistory containing exact replacement JavaScript for the two source snippets below. The facade must lazily construct an authorized task worker so history/evidence work before run and after restart. The private history must preserve the same in-memory revisions array during an active run, including a queued save, while reading durable state when inactive and preserving legacy/recovery behavior. Do not claim tests were run. "+feedback+"\nFACADE:\n"+facade+"\nPRIVATE:\n"+privateHistory}];
let output="",done=false,reportedModel=null,inputTokens=null,outputTokens=null,finish=null;
await runTurn({messages,provider:{...PROVIDERS.groq,id:"groq",key},model:"openai/gpt-oss-120b",root:candidate,
  systemPrompt:"You are Dev in the approved local AI Org supervised repair. Text only; no tools or credentials. Preserve the exact interface.",
  allowedTools:[],freeOnly:true,auto:false,maxRounds:1,maxTokens:4000,effort:"low",signal:AbortSignal.timeout(180000),
  observe(e){if(e.type==="model.result"){reportedModel=e.reportedModel;inputTokens=e.inputTokens;outputTokens=e.outputTokens;finish=e.finish;}},
  emit(e){if(e.t==="delta")output+=e.d;if(e.t==="done")done=true;if(e.t==="error")throw Error(e.message);}});
if(!done||reportedModel!=="openai/gpt-oss-120b"||finish!=="stop")throw Error("Unverified builder completion");
const raw=messages.at(-1)?.content||output;
const edits=JSON.parse(raw.trim().replace(/^```json\s*/i,"").replace(/\s*```$/,""));
if(typeof edits.facadeHistory!=="string"||typeof edits.privateHistory!=="string")throw Error("Invalid repair proposal");
writeFileSync(out,JSON.stringify({edits,model:reportedModel,inputTokens,outputTokens,sourceHash:source.length},null,2),{mode:0o600,flag:"wx"});
console.log(JSON.stringify({model:reportedModel,inputTokens,outputTokens,output:out}));
