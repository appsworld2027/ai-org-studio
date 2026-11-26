import test from "node:test";
import assert from "node:assert/strict";
import {validateLockedSuite} from "../scripts/locked-suite-readiness.mjs";

test("rejects the saved suite's unregistered literal IDs and getter call",()=>{
  const source='const A="studio-pilot-001", B="founder-task-two"; [A,B].map(requestId=>requestId); get calls(){return 0}; act(pilot,"A","save"); act(pilot,"B","save"); calls();';
  assert.deepEqual(validateLockedSuite(source),["unregistered_request_id:A","unregistered_request_id:B","calls_getter_invoked"]);
});
test("accepts fixture IDs and property access",()=>{
  const source='const A="studio-pilot-001", B="founder-task-two"; [A,B].map(requestId=>requestId); get calls(){return 0}; act(pilot,A,"save"); const count=calls;';
  assert.deepEqual(validateLockedSuite(source),[]);
});
