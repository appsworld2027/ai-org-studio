import test from "node:test";
import assert from "node:assert/strict";
import {createDeliveryRateGuard, retryAfterMs} from "../scripts/delivery-rate-limit.mjs";
test("safe Retry-After calculation uses seconds or date and conservative default",()=>{
  assert.equal(retryAfterMs(null,0),60000);
  assert.equal(retryAfterMs("12",0),13000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:30 GMT",0),31000);
  assert.equal(retryAfterMs("nonsense",0),60000);
});
function fixture(statuses,opts={}){
  let time=100000, requests=[], events=[], waits=[];
  const guard=createDeliveryRateGuard({now:()=>time,sleep:async ms=>{time+=ms;waits.push(ms);},
    fetchImpl:async(url,options)=>{requests.push({url,options,at:time});const [status,after]=statuses.shift();
      return new Response(null,{status,headers:after==null?{}:{"retry-after":after}});},...opts});
  const options={method:"POST",body:'{"model":"same-free-model"}'};
  return {requests,events,waits,go:()=>guard.fetch("https://example.test",options,(t,f)=>events.push({t,...f}))};
}
test("429 waits once and retries the identical request without switching model",async()=>{
  const f=fixture([[429,"30"],[200],[200]]);
  assert.equal((await f.go()).status,200);
  assert.equal((await f.go()).status,200);
  assert.deepEqual(f.waits,[31000,21000]);
  assert.equal(f.requests[0].options,f.requests[1].options);
  assert.ok(f.events.some(e=>e.t==="route.cooldown"&&e.httpStatus===429));
  assert.ok(f.events.some(e=>e.t==="route.retry"));
});
test("long quota resets and repeated 429s stop; no unlimited calls",async()=>{
  const long=fixture([[429,"600"]]);assert.equal((await long.go()).status,429);
  assert.equal(long.requests.length,1);assert.equal(long.waits.length,0);
  const repeat=fixture([[429,null],[429,null]]);assert.equal((await repeat.go()).status,429);
  assert.equal(repeat.requests.length,2);assert.deepEqual(repeat.waits,[60000]);
  const budget=fixture([[429,null]],{maxRetries:0});assert.equal((await budget.go()).status,429);assert.equal(budget.requests.length,1);
});
