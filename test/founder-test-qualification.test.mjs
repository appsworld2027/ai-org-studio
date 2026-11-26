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
