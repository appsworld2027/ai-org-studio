import test from "node:test";
import assert from "node:assert/strict";
import { parseDeliveryResponse } from "../scripts/delivery-response.mjs";
const hash="a".repeat(64), patch={kind:"patch",id:"BUILD-01",target:"server/founder-pilot.mjs"};
const code='export function createFounderPilot(config) { return config; }';
const framed=source=>"\x60\x60\x60javascript\n"+source+"\n\x60\x60\x60";
test("patch source binds runner-generated receipt to actual input, not a copied placeholder",()=>{
  const {receipt,issues}=parseDeliveryResponse(framed(code),hash,patch);
  assert.deepEqual(issues,[]);
  assert.equal(receipt.inputArtifactHash,hash);
  assert.equal(receipt.receiptOrigin,"studio-runtime");
  assert.equal(receipt.source,code);
});
test("patch rejects prose, absent or multiple fences, and legacy false receipt",()=>{
  for(const text of ["","The implementation is complete.",framed(code)+"\n"+framed(code),
      JSON.stringify({inputArtifactHash:hash,verdict:"COMPLETE",summary:"REPLACE with evidence, gaps and file names"})+"\n"+framed(code)]){
    assert.equal(parseDeliveryResponse(text,hash,patch).receipt,null);
  }
});
test("review receipt still requires exact hash, verdict and substantive summary",()=>{
  const p={inputArtifactHash:hash,verdict:"APPROVE",summary:"Replaced source is consistent with the contract"};
  assert.ok(parseDeliveryResponse(JSON.stringify(p),hash).receipt);
  for(const [value,expected] of [
    [{...p,inputArtifactHash:"b".repeat(64)},"input_hash_mismatch"],
    [{...p,verdict:"MAYBE"},"invalid_verdict"],
    [{...p,summary:"REPLACE with evidence, gaps and file names"},"placeholder_summary"]]){
    assert.deepEqual(parseDeliveryResponse(JSON.stringify(value),hash).issues,[expected]);
  }
});
test("criterion accepts pretty-printed receipt followed by runnable source; rejects missing test",()=>{
  const p={inputArtifactHash:hash,verdict:"COMPLETE",summary:"Wrote a bounded test"};
  const source='test("AC-01 keeps feedback isolated",()=>{assert.equal(1,1);});';
  assert.equal(parseDeliveryResponse(JSON.stringify(p,null,2)+"\n"+framed(source),hash,{id:"AC-01"}).receipt.source,source);
  assert.equal(parseDeliveryResponse(JSON.stringify(p)+"\n"+framed(code),hash,{id:"AC-01"}).receipt,null);
});
