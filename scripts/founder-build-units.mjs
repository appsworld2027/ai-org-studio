// Small implementation tasks selected from the approved contract and existing
// Studio architecture. The model authors replacement code; the runner validates
// the exact source range and persists each checkpoint.
export const BUILD_UNITS = [
  { id:"BUILD-01", path:"server/founder-pilot.mjs",
    start:"export function createFounderPilot({", end:"  function history(id) {", ac:["AC-01"],
    requirement:"This is a SMALL wrapper extraction, not a new workflow. Export synchronous createFounderPilot(config). Inside it cache workers in a Map. Validate requestId type, /^[a-zA-Z0-9_-]{8,100}$/ and config.inbox.list().some(t => t.requestId === id) before constructing a worker or path. inbox has list(), NOT has(). Public run(input) MUST take the original single object {requestId,action,revision,feedback,coordinate}; return structuredClone(worker.run(input)) synchronously. Public history(id) returns structuredClone(worker.history(id)) synchronously. Public evidence(id = module PILOT_ID) filters worker.evidence().events by requestId, retaining journal result shape and meaningful metadata. Close ONLY the public facade. Then begin private function createTaskPilot(config, taskId) using the ORIGINAL destructuring parameters/defaults and EXACT original mkdir, active Set, file, journal and event helper, with const PILOT_ID = taskId. END immediately after the existing event helper, with private factory body still OPEN: followingContext starts function history(id) and the ORIGINAL rest of the file (including its return and closing brace) is retained. Do NOT implement history, run, save, execute, or evidence inside this replacement. Do not introduce new state or async public methods. Expect roughly 30-45 lines" },
  { id:"BUILD-02", path:"server/founder-pilot.mjs",
    start:"  function history(id) {", end:"  async function execute(task, revisions, record) {", ac:["AC-03","AC-04"],
    requirement:"Preserve existing history/restart/legacy and atomic persistence behavior. Keep a shared in-memory revisions array while this task has active work, so saving a queued correction during the asynchronous run and subsequent persistence from that run reference the same array. When inactive read durable state; assign shared ref even if empty; save must update the shared ref as well as atomic disk state. Do not return a cloned array internally: private worker needs live state. Public facade already clones." },
  { id:"BUILD-03", path:"server/founder-pilot.mjs",
    start:"  function run({ requestId, action,", end:'    if (action === "coordinate") {', ac:["AC-01","AC-03"],
    requirement:"Change run preamble only. Validate action, input and task; allow save while active, block every other action until active task finishes. Read same live revisions. Before the stale-revision error, make identical feedback retried with the same parent revision idempotent ONLY if latest is queued, feedback identical and supplied revision equals latest.parentRevision. Do not bypass invalid input or stale checks for other actions. Preserve the function opening and local variables used by existing following branches. Do not run an agent on save." },
  { id:"BUILD-04", path:"server/founder-pilot.mjs",
    start:'    if (action === "save") {', end:'    if (action === "accept") {', ac:["AC-01","AC-02","AC-03","AC-04"],
    requirement:"Implement validated 1-2000 char feedback save. New revision increments latest one-based ID, parentRevision points to latest; preserve previous accepted contract and historical records. If prior accepted or latest contract exists, record baseRevision/baseArtifactHash and baseContract as an immutable copy if the locked test requires it. Identical queued correction is idempotent. Persist before event and never start a model. Preserve error handling if journal fails. Do not mutate an accepted/running record." },
  { id:"BUILD-05", path:"server/founder-pilot.mjs",
    start:"      const base = revisions.slice(", end:'      const messages = [{ role: "user", content: [', ac:["AC-02","AC-03"],
    requirement:"When building discovery context, use only revisions up to and including record.revision; never feed later queued corrections to an active run. Prefer the most recent earlier accepted contract baseline, otherwise the latest earlier valid contract. Keep base, corrections variables and existing max context and context.prepared evidence; correction count must reflect only this revision's scope. Preserve chronology. No new automatic execution." },
  { id:"BUILD-06", path:"server/server.mjs",
    start:'        if (req.method === "GET") {\n          return json(res, 200, {\n            revisions: pilot.history("studio-pilot-001"),', end:'        if (req.method === "POST") {', ac:["AC-01","AC-04"],
    requirement:"Existing handler already authenticates before this branch. GET should read url.searchParams.get('requestId') with default 'studio-pilot-001' for old clients, delegate history(requestId) and evidence(requestId). Do not weaken authorization or POST behavior. Unknown/invalid IDs rejected by factory. Existing surrounding try/catch reports error." },
  { id:"BUILD-07", path:"public/founder-inbox.js",
    start:'      if (task.requestId === "studio-pilot-001") {', end:"        function textElement(", ac:["AC-01","AC-02","AC-03","AC-04"],
    requirement:"Render the existing panel for every task (replace the hardcoded conditional with a normal block; matching closing brace remains). Preserve all existing controls/functions. Add per-panel anyRunning boolean tracked from all revisions, and use it (plus latest active state) to disable run, acceptance, recovery and coordination when prior work is active. Saving valid feedback remains enabled while active; never trigger a model from save. Keep latest revision controls, busy/available guards and input clearing behavior. No new global state." },
  { id:"BUILD-08", path:"public/founder-inbox.js",
    start:"        async function loadEvidence() {", end:"        function renderCoordination(", ac:["AC-01","AC-02","AC-03","AC-04"],
    requirement:"Fetch /api/founder-pilot?requestId=encoded task.requestId (never another task's data). Set anyRunning from all revisions, including running/reviewing or coordination running/waiting-for-contract; display latest revision first, older revisions in chronological expandable history with feedback/summary/status/timestamps and any errors; keep artifact, decisions, review, and activity rendering. Poll while ANY revision is active, even if latest is queued. Preserve safe textContent construction (no innerHTML). Preserve availability/error and dialog guards. Avoid stale polls after panel detached. Do not start models from polling." }
];
export function sourceRange(text, unit) {
  const start=text.indexOf(unit.start);
  if(start<0||text.indexOf(unit.start,start+unit.start.length)>=0)throw Error("Missing/ambiguous source start for "+unit.id);
  const end=text.indexOf(unit.end,start+unit.start.length);
  if(end<0||end<=start)throw Error("Missing source end for "+unit.id);
  return text.slice(start,end);
}
