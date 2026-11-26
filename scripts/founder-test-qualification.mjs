// Known invalid fixture usages must never masquerade as feature failures.
// These deterministic checks supplement, not replace, executing the tests.
export function fixtureIssues(source) {
  const issues=[];
  if (/["'](?:A|B)["']/.test(source))
    issues.push("literal_fixture_id");
  if (/\bfixture\s*\(\s*test\b/.test(source)) issues.push("wrong_test_context");
  if (/\b(?:calls|modelCalls)\s*\(|\b(?:const|let)\s*\{[^}]*\bcalls\b[^}]*\}/.test(source)) issues.push("wrong_calls_api");
  if (/\.index\b|\.runMayaEnabled\b|\.taskId\b|\bevidence\s*\(.*?\)\.revisions\b/.test(source)) issues.push("invented_fixture_fields");
  if (/\bassert\.rejects\s*\(\s*(?:await\s+)?act\s*\(/.test(source))
    issues.push("wrong_sync_assertion");
  if (/\b(?:test|it)\.(?:skip|todo|only)\b|\b(?:skip|todo)\s*:\s*true/.test(source))
    issues.push("disabled_test");
  return issues;
}
export function baselineQuality(report, evidence) {
  // A regression suite can have existing behavior that passes on baseline.
  // Require evidence of at least one actual missing feature, not broken fixtures.
  if (evidence.exitCode!==1 || evidence.fail<1 || evidence.pass+evidence.fail!==4 ||
      /ERR_MODULE_NOT_FOUND|SyntaxError|ERR_ACCESS_DENIED|Invalid requestId|\b(?:TypeError|ReferenceError)\b|calls is not a function|t\.after is not a function|unknown test context/i.test(report) ||
      /# (?:skipped|todo) [1-9]/.test(report)) return false;
  return /ERR_ASSERTION|Outside pilot scope|Only the synthetic pilot is enabled|A supervised agent is already working/i.test(report);
}

// Explicit amendment of the observed fixture-v2 suite. Exact unique matches
// guard against silently altering a different model response. The original
// Quinn fragments and hashes remain untouched and separately auditable.
export function amendObservedFixtureV2(source) {
  const changes=[];
  const edit=(id,old,replacement)=>{
    const at=source.indexOf(old);
    if(at<0||source.indexOf(old,at+old.length)>=0)throw Error("Unexpected saved fixture source: "+id);
    source=source.slice(0,at)+replacement+source.slice(at+old.length);
    changes.push(id);
  };
  edit("AC-01: valid parent and feedback error", 'assert.throws(() => act(pilot, A, "save", null, ""), /feedback must be 1–2000 chars/);',
    'assert.throws(() => act(pilot, A, "save", savedA.revision, ""), /1[–-]2000/);');
  edit("AC-01: valid parent and oversized feedback", 'assert.throws(() => act(pilot, A, "save", null, "x".repeat(2001)), /feedback must be 1–2000 chars/);',
    'assert.throws(() => act(pilot, A, "save", savedA.revision, "x".repeat(2001)), /1[–-]2000/);');
  edit("AC-01: verify save uses no model", 'assert.equal(savedB.parentRevision, null);',
    'assert.equal(savedB.parentRevision, null);\n  assert.equal(f.calls, 0);\n  assert.equal(pilot.history(B).length, 1);');
  edit("AC-01: seed held fixture before run", 'act(hp, A, "run", 1);',
    'const heldSaved = act(hp, A, "save", null, "held initial feedback");\n  act(hp, A, "run", heldSaved.revision);');
  edit("AC-01: correction uses active parent", 'act(hp, A, "save", null, "correction during run");',
    'act(hp, A, "save", heldSaved.revision, "correction during run");');
  edit("AC-01: recover the correct fixture", 'const {createFounderPilot} = await import("../server/founder-pilot.mjs");\n  const pilot2 = createFounderPilot(config);\n  const hist = pilot2.history(A);',
    'const pilot2 = createFounderPilot(held.config);\n  const hist = pilot2.history(A);');
  edit("AC-01: assert real offered artifact rather than nonexistent fields", `for (const e of ev.events) {
    if (e.type === "offer" && e.ackHash) {
      const ack = ev.events.find(x => x.type === "ack" && x.hash === e.ackHash);
      assert(ack, "ack matches offer hash");
    }
  }`, `const offer = ev.events.find(e => e.type === "handoff.offered" && e.revision === 1);
  assert.ok(offer, "completed revision has real handoff");
  assert.equal(offer.artifactHash, hist[0].artifactHash);
  assert.ok(ev.events.every(e => e.requestId === A));`);
  edit("AC-02: compare actual journal events", 'assert.equal(ack.artifactHash, ack.offerHash, "ack/offer hash mismatch");',
    `const offer = events.find(e => e.type === "handoff.offered" && e.revision === reviewed.revision && e.executionId === ack.executionId);
  assert.ok(offer, "matching offer missing");
  assert.equal(ack.artifactHash, offer.artifactHash, "ack/offer hash mismatch");
  assert.equal(ack.artifactHash, reviewed.artifactHash);`);
  edit("AC-02: correction forks from accepted parent", 'act(pilot, A, "save", null, "correction feedback");',
    'act(pilot, A, "save", accepted.revision, "correction feedback");');
  edit("AC-03: explicit run after save", 'const rev0 = act(pilot, A, "run", null);',
    'const saved = act(pilot, A, "save", null, "initial direction");\n  const rev0 = act(pilot, A, "run", saved.revision);');
  edit("AC-03: active correction targets parent", 'act(pilot, A, "save", null, "new direction");',
    'act(pilot, A, "save", rev0.revision, "new direction");');
  edit("AC-03: prove no automatic launch after completion", 'assert.ok(Array.isArray(events));',
    'assert.ok(Array.isArray(events));\n  assert.equal(f.calls, 1);\n  act(pilot, A, "run", rev1.revision);\n  await waitFor(pilot, A, rev1.revision, "founder-review");\n  assert.equal(f.calls, 2);\n  assert.equal(pilot.history(A)[0].artifactHash, completed.artifactHash);');
  edit("AC-04: compare actual acknowledgements for both accepted revisions", `for (const event of evidence.events) {
    if (event.offerHash && event.ackHash) {
      assert.equal(event.offerHash, event.ackHash);
    }
  }`, `for (const r of history.slice(0,2)) {
    const offer = evidence.events.find(e => e.type === "handoff.offered" && e.revision === r.revision && e.executionId === r.executionId);
    const ack = evidence.events.find(e => e.type === "handoff.acknowledged" && e.revision === r.revision && e.executionId === r.executionId);
    assert.ok(offer && ack, "missing recorded offer/ack");
    assert.equal(offer.artifactHash, ack.artifactHash);
    assert.equal(ack.artifactHash, r.artifactHash);
  }`);
  return {source,changes};
}
