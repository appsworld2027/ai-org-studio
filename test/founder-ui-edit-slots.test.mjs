import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILD_UNITS, sourceRange } from "../scripts/founder-build-units.mjs";
import { uiEditSlots } from "../scripts/founder-ui-edit-slots.mjs";
import { parseDeliveryResponse } from "../scripts/delivery-response.mjs";
import { spawnSync } from "node:child_process";

// Protocol fixtures only: not product code or a claim of real model execution.
// BUILD-07/08 operate on the pre-delivery source at fc19355; the delivered UI
// intentionally no longer contains those old anchors.
test("UI slots are unique in the pinned original pre-build source ranges and preserve all unedited code",()=>{
  let current=readFileSync(new URL("./fixtures/founder-inbox-prebuild-fc19355.js.txt",import.meta.url),"utf8");
  for(const id of ["BUILD-07","BUILD-08"]){
    const unit=BUILD_UNITS.find(u=>u.id===id);
    const old=sourceRange(current,unit),slots=uiEditSlots(id,old);
    // Add harmless inline comments to each exact statement; model-authored
    // substantive edits are validated separately in the real delivery.
    const edits=Object.fromEntries(slots.map(s=>[s.id,s.old+" /* protocol test */"]));
    const {receipt,issues}=parseDeliveryResponse(JSON.stringify(edits),"a".repeat(64),{kind:"patch",id,target:unit.path,old,slots});
    assert.deepEqual(issues,[]);
    assert.equal(receipt.source.replaceAll(" /* protocol test */",""),old);
    current=current.replace(old,()=>receipt.source);
  }
  assert.equal(spawnSync(process.execPath,["--input-type=module","--check"],{input:current}).status,0);
});
test("slot selection fails closed when existing source changes",()=>{
  assert.equal(uiEditSlots("BUILD-06","anything"),null);
  assert.throws(()=>uiEditSlots("BUILD-07","missing"),/Missing or ambiguous UI edit slot/);
});
