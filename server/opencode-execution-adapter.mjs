// Supervised, text-only OpenCode route. The caller owns artifact validation.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OPENCODE_FREE_MODEL = "opencode/deepseek-v4.1-flash-free";
const CLI = "/home/ankit_mittal_mds02/.ai-org-tools/opencode/node_modules/.bin/opencode";
export function parseOpenCodeEvents(output, requestedModel=OPENCODE_FREE_MODEL) {
  let text="", model, tokens, cost, error, unauthorized=false;
  for(const line of output.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event=JSON.parse(line); } catch { throw Error("Invalid OpenCode JSON event"); }
    if(event.type==="error")error=event.error?.message||event.properties?.message||"OpenCode error";
    if(event.type==="tool_use"||event.type==="permission"||event.type==="tool.request")unauthorized=true;
    if(event.type==="text")text+=event.part?.text??event.properties?.part?.text??"";
    if(event.type==="step_finish"){
      const p=event.part??event.properties?.part??{};
      model=p.model?.providerID&&p.model?.modelID?`${p.model.providerID}/${p.model.modelID}`:p.model||model;
      tokens=p.tokens??tokens;cost=p.cost??cost;
    }
  }
  if(error)throw Error(error);
  if(unauthorized)throw Error("Unauthorized OpenCode tool request");
  if(model!==requestedModel)throw Error("OpenCode model identity unverified");
  if(typeof cost!=="number"||cost!==0)throw Error("OpenCode free-only cost unverified");
  if(!tokens||!Number.isFinite(tokens.input)||!Number.isFinite(tokens.output))throw Error("OpenCode token usage missing");
  if(!text.trim())throw Error("OpenCode returned no source");
  return {text,model,tokens,cost};
}

export function runOpenCodeText({prompt,model=OPENCODE_FREE_MODEL,timeoutMs=180000,cli=CLI,spawn=spawnSync}) {
  if(model!==OPENCODE_FREE_MODEL)throw Error("Unqualified OpenCode model");
  if(typeof prompt!=="string"||!prompt.trim())throw Error("Missing OpenCode prompt");
  const dir=mkdtempSync(join(tmpdir(),"studio-opencode-"));
  try {
    const config={permissions:[{action:"*",resource:"*",effect:"deny"}],mcp:{}};
    const env={PATH:process.env.PATH,HOME:dir,XDG_DATA_HOME:join(dir,"data"),XDG_CONFIG_HOME:join(dir,"config"),XDG_CACHE_HOME:join(dir,"cache"),OPENCODE_CONFIG_CONTENT:JSON.stringify(config),CI:"1"};
    const result=spawn(cli,["run","--standalone","--archived","--format","json","--model",model,prompt],
      {cwd:dir,env,encoding:"utf8",timeout:timeoutMs,maxBuffer:2*1024*1024});
    if(result.error?.code==="ETIMEDOUT")throw Error("OpenCode timeout");
    if(result.error)throw result.error;
    if(result.status!==0){
      const event=String(result.stdout||"").split(/\r?\n/).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(e=>e.type==="error");
      throw Error("OpenCode unavailable or rejected request: "+String(event?.error?.message||result.stderr||"unknown CLI failure").slice(0,200));
    }
    return parseOpenCodeEvents(result.stdout,model);
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
