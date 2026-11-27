import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MARKER = /^<!-- ai-org:runtime:v1 state=(started|executing|completed|paused|blocked|failed|claimed|dispatch_failed) stage=(ai:[a-z][a-z0-9-]*) run=([1-9]\d*) attempt=([1-9]\d*) mode=(readonly|standard) -->$/;
const validRepo = (s) => typeof s === "string" && /^[\w.-]+\/[\w.-]+$/.test(s);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export function projectRuntimeStatus(issue, comments, repository, run = null) {
  const labels = new Set((issue?.labels || []).map(l => typeof l === "string" ? l : l.name));
  const receipts = comments.flatMap(c => {
    if (c.user?.login !== "github-actions[bot]" || c.user?.type !== "Bot" || !positive(c.id)) return [];
    const match = MARKER.exec(String(c.body || "").split(/\r?\n/, 1)[0]);
    if (!match || !labels.has(match[2])) return [];
    const [, state, stage, runId, attempt, mode] = match;
    if (!positive(Number(runId)) || !positive(Number(attempt))) return [];
    return [{ state, stage, runId: Number(runId), attempt: Number(attempt), mode, receiptId: c.id, at: c.created_at }];
  }).sort((a,b) => b.receiptId - a.receiptId);
  const receipt = receipts[0];
  if (!receipt) return { state: "not-observed" };
  const match = run?.id === receipt.runId && run?.run_attempt === receipt.attempt;
  return {
    ...receipt,
    runUrl: "https://github.com/" + repository + "/actions/runs/" + receipt.runId,
    runStatus: match ? run.status : "unavailable",
    runConclusion: match ? run.conclusion || null : null,
    attemptVerified: Boolean(match && receipt.state === "completed" && run.status === "completed" && run.conclusion === "success"),
  };
}

export function makeRuntimeObserver({ gh, checkpoint = async () => {}, clock = Date.now, ttlMs = 30000 }) {
  const cache = new Map();
  async function observe(task) {
    const { repository, githubIssueNumber: number } = task;
    if (!validRepo(repository) || !positive(number)) return { state: "not-observed" };
    const key = repository.toLowerCase() + "#" + number;
    const cached = cache.get(key);
    if (cached && clock() - cached.at < ttlMs) return cached.promise;
    const promise = (async () => {
      try {
        const root = "repos/" + repository;
        const [issue, pages] = await Promise.all([
          gh(["api", root + "/issues/" + number]),
          gh(["api", "--paginate", "--slurp", root + "/issues/" + number + "/comments?per_page=100"])
        ]);
        const comments = pages.flat();
        let status = projectRuntimeStatus(issue, comments, repository);
        if (status.runId) {
          const run = await gh(["api", root + "/actions/runs/" + status.runId]).catch(() => null);
          status = projectRuntimeStatus(issue, comments, repository, run);
          try { await checkpoint(task, status); }
          catch { status.checkpointUnavailable = true; }
        }
        return status;
      } catch { return { state: "unavailable" }; }
    })();
    cache.set(key, { at: clock(), promise });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return promise;
  }
  return async tasks => {
    // Bound network work; older submitted tasks can be inspected at their issue links.
    const recent = tasks.filter(t => positive(t.githubIssueNumber)).slice(0, 10);
    const statuses = new Map();
    for (let i = 0; i < recent.length; i += 3) {
      await Promise.all(recent.slice(i, i + 3).map(async t => statuses.set(t.requestId, await observe(t))));
    }
    return tasks.map(t => ({ ...t, runtime: statuses.get(t.requestId) || { state: "not-observed" } }));
  };
}

// Adjacent to, not inside, the Git-backed Garage: no accidental git add/push.
// Contains only canonical receipt metadata; never task descriptions, code, logs, or credentials.
export function makeRuntimeCheckpointStore(dir) {
  const pending = new Map();
  return (task, status) => {
    if (!validRepo(task.repository) || !positive(task.githubIssueNumber) || !positive(status.receiptId)) return Promise.resolve();
    const key = task.repository.toLowerCase().replace("/", "__") + "-" + task.githubIssueNumber;
    const previous = pending.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, key + ".json");
      let old;
      try { old = JSON.parse(await readFile(path, "utf8")); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
      if (old && old.receiptId > status.receiptId) return;
      if (old && old.receiptId === status.receiptId && old.runStatus === status.runStatus && old.runConclusion === status.runConclusion) return;
      const { state, stage, runId, attempt, mode, receiptId, at, runUrl, runStatus, runConclusion, attemptVerified } = status;
      const data = { version: 1, repository: task.repository, issue: task.githubIssueNumber, state, stage, runId, attempt, mode, receiptId, at, runUrl, runStatus, runConclusion, attemptVerified };
      const temp = path + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temp, path);
    });
    pending.set(key, operation);
    return operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); });
  };
}
