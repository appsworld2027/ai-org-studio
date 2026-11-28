
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareGarageTurn, persistGarageTurn, completeGarageTurn } from "../server/garage-turn.mjs";

test("A-12 configured stale or missing Garage blocks a new free turn", async () => {
  const notes = [];
  const emit = n => notes.push(n);
  for (const receipt of [
    { ok: false, available: true, configured: true, reason: "Recovery failed" },
    { ok: false, available: false, configured: true, reason: "Recovery unavailable" }
  ]) {
    await assert.rejects(prepareGarageTurn({ pull: async () => receipt }, emit), /Recovery/);
  }
  assert.equal(notes.length, 0);
  const noGarage = { ok: false, available: false, configured: false };
  assert.equal(await prepareGarageTurn({ pull: async () => noGarage }, emit), noGarage);
  assert.match(notes[0].message, /shared cross-session memory is unavailable/);
  const recovered = { ok: true, available: true, head: "fixture" };
  assert.equal(await prepareGarageTurn({ pull: async () => recovered }, emit), recovered);
});

test("A-12 turn checkpoint awaits journal and save and reports incomplete results", async () => {
  const p = { id: "synthetic" }, info = { engine: "free:fixture", ask: "Test recovery" };
  const calls = [];
  const garage = { ready: () => true, journal: () => calls.push("journal"), save: async () => { calls.push("save"); return { ok: true, pushed: true }; } };
  assert.deepEqual(await persistGarageTurn(garage, p, info), { ok: true, pushed: true, available: true });
  assert.deepEqual(calls, ["journal", "save"]);
  const journalFailed = await persistGarageTurn({ ...garage, journal: () => { throw new Error("fixture"); } }, p, info);
  assert.equal(journalFailed.ok, false);
  assert.match(journalFailed.reason, /journal failed/);
  const saveFailed = await persistGarageTurn({ ...garage, save: async () => { throw new Error("fixture"); } }, p, info);
  assert.equal(saveFailed.ok, false);
  assert.equal(saveFailed.pushed, false);
});

test("A-12 busy turn stays reserved until checkpoint receipt and reports failure before idle", async () => {
  const events = [];
  let resolve;
  const receipt = new Promise(r => { resolve = r; });
  const completed = completeGarageTurn({
    checkpoint: () => receipt, emit: e => events.push(e.t), release: () => events.push("idle")
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  resolve({ ok: false, available: true, pushed: false });
  await completed;
  assert.deepEqual(events, ["note", "idle"]);
  const successful = [];
  await completeGarageTurn({ checkpoint: async () => ({ ok: true }), emit: e => successful.push(e.t), release: () => successful.push("idle") });
  assert.deepEqual(successful, ["idle"]);
  const preflightFailure = [];
  await completeGarageTurn({ checkpoint: null, emit: e => preflightFailure.push(e.t), release: () => preflightFailure.push("idle") });
  assert.deepEqual(preflightFailure, ["idle"]);
});

test("A-12 free chat handler reserves, recovers, runs and awaits completion in order", () => {
  const server = readFileSync(new URL("../server/server.mjs", import.meta.url), "utf8");
  const body = server.slice(server.indexOf("async function chatTurn("), server.indexOf("// ---------- Claude Code / Codex chats"));
  const stages = ["L.abort = ac", "await prepareGarageTurn(garage, emit)", "c.messages.push", "await runTurn(", "await completeGarageTurn(", "L.abort = null; emit({ t: \"idle\" })"];
  let prev = -1;
  for (const stage of stages) {
    const at = body.indexOf(stage);
    assert.ok(at > prev, "Missing or out-of-order stage: " + stage);
    prev = at;
  }
  assert.match(body, /c\.messages\.slice\(messageStart\)/);
  assert.match(body, /checkpoint: started \?/);
});
