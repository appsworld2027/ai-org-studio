import { createHash } from "node:crypto";
import { artifactDigest } from "../server/execution-journal.mjs";
import { stageRoute, modelMatches } from "../server/pilot-model-profile.mjs";

// Replayed work is accepted only with original completion/handoff receipts,
// exact file bytes, model identity, unchanged test hash, and source continuity.
export const REPAIR_IDS=["BUILD-09","BUILD-10","BUILD-11"];
export function verifyRepairCheckpoint({unit,index,stage,events,bytes,currentHash,locked,model}) {
  if(!unit||unit.id!==REPAIR_IDS[index]||unit.path!=="server/founder-pilot.mjs"||
      unit.beforeHash!==currentHash||unit.lockedTestHash!==locked||!stage||
      stage.executionId!==unit.executionId||stage.role!=="dev-coder"||stage.stage!=="ai:build"||
      stage.status!=="completed"||stageRoute(stage)!==model||
      !modelMatches(stage.requestedModel,stage.reportedModel,stage.providerId)||
      stage.artifact?.receipt?.verdict!=="COMPLETE"||
      artifactDigest(stage.artifact)!==unit.artifactHash||stage.artifactHash!==unit.artifactHash||
      stage.artifact?.files?.[unit.path]!==unit.afterHash||
      createHash("sha256").update(bytes).digest("hex")!==unit.afterHash)return false;
  const relevant=events.filter(e=>e.executionId===unit.executionId);
  return (relevant.some(e=>e.type==="stage.completed"&&e.artifactHash===unit.artifactHash)&&
    relevant.some(e=>e.type==="handoff.received"&&e.artifactHash===stage.inputArtifactHash))||
    (stage.reused===true&&relevant.some(e=>e.type==="stage.reused"&&e.artifactHash===unit.artifactHash));
}
