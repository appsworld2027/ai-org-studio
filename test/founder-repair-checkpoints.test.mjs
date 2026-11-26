import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { artifactDigest } from "../server/execution-journal.mjs";
import { verifyRepairCheckpoint } from "../scripts/founder-repair-checkpoints.mjs";
test("functional checkpoint replay requires exact source, lock, model and handoff",()=>{
  const bytes=Buffer.from("repair source"), path="server/founder-pilot.mjs";
  const afterHash=createHash("sha256").update(bytes).digest("hex"), locked="a".repeat(64), currentHash="b".repeat(64);
  const artifact={receipt:{verdict:"COMPLETE"},files:{[path]:afterHash}};
  const artifactHash=artifactDigest(artifact),stage={role:"dev-coder",stage:"ai:build",status:"completed",
    executionId:"stage-one",inputArtifactHash:"c".repeat(64),providerId:"groq",requestedModel:"openai/gpt-oss-120b",
    reportedModel:"openai/gpt-oss-120b",artifact,artifactHash};
  const unit={id:"BUILD-09",path,beforeHash:currentHash,afterHash,lockedTestHash:locked,executionId:stage.executionId,artifactHash};
  const events=[{type:"stage.completed",executionId:stage.executionId,artifactHash},
    {type:"handoff.received",executionId:stage.executionId,artifactHash:stage.inputArtifactHash}];
  const args={unit,index:0,stage,events,bytes,currentHash,locked,model:"groq:openai/gpt-oss-120b"};
  assert.equal(verifyRepairCheckpoint(args),true);
  for(const change of [{index:1},{bytes:Buffer.from("tampered")},{locked:"bad"},{currentHash:"bad"},{events:events.slice(0,1)},
    {stage:{...stage,reportedModel:"openai/gpt-oss-20b"}},{unit:{...unit,artifactHash:"bad"}}])
    assert.equal(verifyRepairCheckpoint({...args,...change}),false);
  assert.equal(verifyRepairCheckpoint({...args,stage:{...stage,reused:true},
    events:[{type:"stage.reused",executionId:stage.executionId,artifactHash}]}),true);
});
