import test from "node:test";
import assert from "node:assert/strict";
import { fixtureIssues, baselineQuality } from "../scripts/founder-test-qualification.mjs";
test("known fixture misuse cannot be locked as an acceptance test",()=>{
  assert.deepEqual(fixtureIssues('test("AC-01",async (t)=>{const f=fixture(t);const r=act(f.pilot,A,"save",null,"fix");assert.equal(r.revision,1);assert.equal(f.calls,0);});'),[]);
  const bad='const f=fixture(test); const r=act(f.pilot,"A","save",null,"x"); assert.equal(r.index,0); calls(); assert.rejects(act(f.pilot,B,"save",null,""));';
  assert.deepEqual(fixtureIssues(bad),["literal_fixture_id","wrong_test_context","wrong_calls_api","invented_fixture_fields","wrong_sync_assertion"]);
  assert.deepEqual(fixtureIssues('test.skip("AC-01",()=>{})'),["disabled_test"]);
});
test("baseline rejects broken fixture failures and accepts actual missing feature",()=>{
  const counts={exitCode:1,pass:1,fail:3};
  assert.equal(baselineQuality("Only the synthetic pilot is enabled",counts),true);
  assert.equal(baselineQuality("ERR_ASSERTION\nInvalid requestId",counts),false);
  assert.equal(baselineQuality("ERR_ASSERTION\nTypeError: calls is not a function",counts),false);
  assert.equal(baselineQuality("ERR_ASSERTION\n# skipped 1",counts),false);
  assert.equal(baselineQuality("ERR_ASSERTION",{...counts,fail:2}),false);
});

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { amendObservedFixtureV2 } from "../scripts/founder-test-qualification.mjs";

test("observed Quinn output is amended transparently and only on exact unique matches",()=>{
  const original=readFileSync(new URL("fixtures/founder-quinn-v2-observed.txt",import.meta.url),"utf8");
  const corrected=amendObservedFixtureV2(original);
  assert.equal(corrected.changes.length,13);
  assert.match(corrected.source,/createFounderPilot\(held.config\)/);
  assert.match(corrected.source,/ack.artifactHash, offer.artifactHash/);
  assert.match(corrected.source,/assert.equal\(f.calls, 2\)/);
  assert.throws(()=>amendObservedFixtureV2(corrected.source),/Unexpected saved fixture source/);
  assert.throws(()=>amendObservedFixtureV2(original.replace('const rev0 = act(pilot, A, "run", null);','not the observed suite')),/Unexpected saved fixture source/);
});

test("sandbox preload preserves writes and never bypasses non-journal fsync restrictions",t=>{
  const scratch=mkdtempSync(join(tmpdir(),"journal-preload-"));
  t.after(()=>rmSync(scratch,{recursive:true,force:true}));
  const preload=fileURLToPath(new URL("../scripts/founder-test-preload.mjs",import.meta.url));
  const result=spawnSync(process.execPath,["--permission","--allow-fs-read="+scratch,"--allow-fs-read="+preload,
    "--allow-fs-write="+scratch,"--import",preload,"--input-type=module","-e",`
      import fs from "node:fs";
      import assert from "node:assert/strict";
      const p=process.env.TMPDIR+"/execution-events.jsonl";
      const fd=fs.openSync(p,"a");
      fs.writeFileSync(fd,"audit record");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      assert.equal(fs.readFileSync(p,"utf8"),"audit record");
      const other=fs.openSync(process.env.TMPDIR+"/other","w");
      try {
        try { fs.fsyncSync(other); } catch(e) { assert.equal(e.code,"ERR_ACCESS_DENIED"); }
      } finally { fs.closeSync(other); }
      assert.throws(()=>fs.writeFileSync("/tmp/permission-check-outside-test","x"),{code:"ERR_ACCESS_DENIED"});
    `],{env:{PATH:process.env.PATH,TMPDIR:scratch,HOME:scratch},encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
});
