import test from "node:test";
import assert from "node:assert/strict";
import {runOpenCodeText,parseOpenCodeEvents,OPENCODE_FREE_MODEL} from "../server/opencode-execution-adapter.mjs";
import {parseDeliveryResponse} from "../scripts/delivery-response.mjs";
const hash="a".repeat(64);
const events=(receipt, extra=[])=>[
  {type:"text",part:{text:receipt}},...extra,
  {type:"step_finish",part:{model:{providerID:"opencode",modelID:"deepseek-v4.1-flash-free"},cost:0,tokens:{input:123,output:45}}}
].map(x=>JSON.stringify(x)).join("\n");
test("valid free output retains identity, usage, and receipt hash",()=>{
  const receipt=JSON.stringify({inputArtifactHash:hash,verdict:"APPROVE",summary:"Reviewed isolated task history and found no mismatch"});
  const result=parseOpenCodeEvents(events(receipt));
  assert.equal(result.model,OPENCODE_FREE_MODEL);assert.deepEqual(result.tokens,{input:123,output:45});
  assert.ok(parseDeliveryResponse(result.text,hash).receipt);
  assert.deepEqual(parseDeliveryResponse(result.text,"b".repeat(64)).issues,["input_hash_mismatch"]);
});
test("invalid receipt stays invalid",()=>{
  const result=parseOpenCodeEvents(events(JSON.stringify({inputArtifactHash:hash,verdict:"COMPLETE",summary:"REPLACE with evidence, gaps and file names"})));
  assert.deepEqual(parseDeliveryResponse(result.text,hash).issues,["placeholder_summary"]);
});
test("unavailable model, cost, missing identity, and unauthorized tool request fail closed",()=>{
  assert.throws(()=>runOpenCodeText({prompt:"hello",model:"opencode/paid-model",spawn:()=>{throw Error("should not spawn")}}),/Unqualified/);
  assert.throws(()=>parseOpenCodeEvents(events("hi",[{type:"tool_use",part:{tool:"shell"}}])),/Unauthorized/);
  assert.throws(()=>parseOpenCodeEvents(events("hi").replace('"cost":0','"cost":1')),/cost unverified/);
  assert.throws(()=>parseOpenCodeEvents(events("hi").replace('"modelID":"deepseek-v4.1-flash-free"','"modelID":"other"')),/identity unverified/);
});
test("timeout and unavailable CLI are bounded",()=>{
  assert.throws(()=>runOpenCodeText({prompt:"hello",spawn:()=>({error:Object.assign(Error("timeout"),{code:"ETIMEDOUT"})})}),/timeout/);
  assert.throws(()=>runOpenCodeText({prompt:"hello",spawn:()=>({status:1,stderr:"model unavailable"})}),/unavailable/);
});
