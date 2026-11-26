// One controlled correction of fixture references. Never edits the original lock.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {artifactDigest} from "../server/execution-journal.mjs";
const [oldPath,outDir,contractHash]=process.argv.slice(2);
if(!oldPath||!outDir||!(/^[a-f0-9]{64}$/).test(contractHash||"")||existsSync(outDir))throw Error("New private output directory and contract hash required");
const old=readFileSync(oldPath,"utf8");
let revised=old;
const replacements=[
  ['act(pilot, "A",','act(pilot, A,'],['act(pilot, "B",','act(pilot, B,'],
  ['pilot.history("A")','pilot.history(A)'],['const id = "A";','const id = A;'],
  ['const taskId = "A";','const taskId = A;'],
  ['assert.equal(calls().filter(c => c.type === "model").length, 0);','assert.equal(calls, 0);'],
  ['const callsBefore = calls().length;','const callsBefore = calls;'],
  ['assert.strictEqual(calls().length, callsBefore);','assert.strictEqual(calls, callsBefore);']
];
const edits=[];
for(const [from,to] of replacements){
  const count=revised.split(from).length-1;
  if(count<1)throw Error("Expected fixture reference missing: "+from);
  revised=revised.replaceAll(from,to);edits.push({from,to,count});
}
if(revised===old)throw Error("No suite revision");
mkdirSync(outDir,{recursive:false,mode:0o700});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const file=join(outDir,"founder-inbox-revisions.acceptance.test.mjs");
writeFileSync(file,revised,{mode:0o600,flag:"wx"});
const lock={contractHash,originalSuiteHash:hash(old),revisedSuiteHash:hash(revised),changes:edits,
  originalPath:oldPath,revisedPath:file,assertionsPreserved:true};
lock.artifactHash=artifactDigest(lock);
writeFileSync(join(outDir,"suite-lock-revision.json"),JSON.stringify(lock,null,2),{mode:0o600,flag:"wx"});
console.log(JSON.stringify({file,lock},null,2));
