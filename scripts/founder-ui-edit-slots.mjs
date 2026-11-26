// Restrict the two UI build units to the statements that need to change.
// Models still author the replacement statements; the existing DOM and
// functions outside these exact slots are copied by Studio, not regenerated.
const UI_SLOTS = {
  "BUILD-07": [
    ["panelScope", '      if (task.requestId === "studio-pilot-001") {', "Open an unconditional block with the same indentation; do not close it here."],
    ["panelState", "        let latest = null, busy = false, available = false, timer;", "Preserve the declarations, adding anyRunning initialized to false."],
    ["runningGuard", '          const running = latest?.status === "running" ||\n            ["running", "waiting-for-contract"].includes(latest?.coordination?.status);', "Include anyRunning plus running/reviewing latest status and the existing coordination conditions."],
    ["recoverGuard", "          recover.disabled = !available || busy || !recoverable;", "Also disable recovery while running."],
    ["saveGuard", "          save.disabled = !available || busy || running || !feedback.value.trim();", "Allow valid nonblank corrections to be saved during active work; preserve busy and available guards."],
  ],
  "BUILD-08": [
    ["fetchTask", '          const response = await fetch("/api/founder-pilot");', "Fetch this task only, using encodeURIComponent(task.requestId) in requestId query."],
    ["responseGuard", "          const { revisions, executionEvidence } = await response.json();", "Keep the destructuring, but return without rendering if the dialog is closed or panel detached."],
    ["runningState", "          latest = revisions.at(-1) || null;", "Preserve latest assignment. Set anyRunning from all revisions, including running/reviewing and the existing coordination states."],
    ["historyOrder", "          for (const r of [...revisions].reverse()) {", "Latest first; then earlier revisions in chronological order. Preserve the open for-loop block and r binding."],
    ["historyDates", '            textElement("h4", "Revision " + r.revision + " — " + r.status, card);', "Keep heading; add created, started, completed or accepted timestamp if present, using textElement and safe text. No HTML."],
    ["pollGuard", '          if ((latest?.status === "running" || ["running", "waiting-for-contract"].includes(latest?.coordination?.status)) && dialog.open && panel.isConnected) {', "Poll when anyRunning and dialog open and panel connected. Preserve the open if-block and existing following timer body."],
  ]
};
export function uiEditSlots(id, source) {
  const rows = UI_SLOTS[id];
  if (!rows) return null;
  return rows.map(([id,old,task]) => {
    if (!source.includes(old) || source.indexOf(old) !== source.lastIndexOf(old))
      throw Error("Missing or ambiguous UI edit slot " + id);
    return {id,old,task};
  });
}
