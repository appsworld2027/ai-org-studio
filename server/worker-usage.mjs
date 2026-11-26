import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEntry } from "./usage.mjs";

export function readWorkerReport(text, product) {
  const report = JSON.parse(text);
  if (report.version !== 1 || !Number.isSafeInteger(report.at) || report.at <= 0 || !Array.isArray(report.rows)) return [];
  const label = (s) => typeof s === "string" && s.length <= 160 ? s : "";
  return report.rows.slice(0, 20).map((row) => makeEntry({
    product, at: report.at, engine: "github:nvidia", role: label(row.role) || "GitHub agent",
    model: label(row.model), modelSource: "adapter", requestedModel: label(row.requestedModel),
    input: row.input, output: row.output, cache: row.cache,
  }));
}

export function makeWorkerUsage({ gh, ghJson, now = Date.now }) {
  const cache = new Map();
  async function load(product) {
    const result = await ghJson(`repos/${product.repo}/actions/artifacts?per_page=50`);
    const artifacts = (result?.artifacts || []).filter((a) => /^ai-org-usage-\d+$/.test(a.name) &&
      !a.expired && a.size_in_bytes <= 65536 && Number.isSafeInteger(a.workflow_run?.id)).slice(0, 5);
    const reports = await Promise.allSettled(artifacts.map(async (artifact) => {
      const dir = mkdtempSync(join(tmpdir(), "studio-worker-usage-"));
      try {
        await gh(["run", "download", String(artifact.workflow_run.id), "--repo", product.repo, "--name", artifact.name, "--dir", dir], 8000);
        const file = join(dir, "ai-org-usage.json");
        if (statSync(file).size > 65536) throw new Error("Usage report exceeds size limit");
        return readWorkerReport(readFileSync(file, "utf8"), product.id);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }));
    return { entries: reports.flatMap((r) => r.status === "fulfilled" ? r.value : []),
      reports: reports.filter((r) => r.status === "fulfilled").length, attempted: artifacts.length, available: true };
  }
  return (product) => {
    const key = JSON.stringify([product.id, product.repo]);
    const prior = cache.get(key), time = now();
    if (prior && time - prior.at < 300000) return prior.result;
    const result = load(product).catch(() => ({ entries: [], reports: 0, attempted: 0, available: false }));
    cache.set(key, { at: time, result });
    return result;
  };
}
