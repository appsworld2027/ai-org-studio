// Measured AI usage ledger: which model did how much work. Only numbers an engine actually reported are stored.
// A number the engine did not report stays null and is shown as "Unknown" — never 0, never a guess.
const MAX = 5000;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export function makeEntry(e = {}) {
  return { at: e.at || Date.now(), product: String(e.product || ""), engine: String(e.engine || "unknown"), model: String(e.model || "unknown"),
    requestedModel: String(e.requestedModel || ""), modelSource: e.modelSource || "unverified", reasoning: num(e.reasoning),
    role: String(e.role || "Studio chat"), input: num(e.input), output: num(e.output), cache: num(e.cache), cost: num(e.cost), ms: num(e.ms) };
}
export function makeLedger(store, file = "usage.json") {
  return {
    record(e) { const all = store.readJson(file, { entries: [] }).entries; all.push(makeEntry(e)); store.writeJson(file, { entries: all.slice(-MAX) }); },
    entries: (product) => store.readJson(file, { entries: [] }).entries.filter((x) => !product || x.product === product),
  };
}
const add = (a, b) => (b == null ? a : (a ?? 0) + b);
export function summarize(entries, { since = 0 } = {}) {
  const rows = new Map();
  const empty = () => ({ turns: 0, input: null, output: null, cache: null, reasoning: null, cost: null, unknownTurns: 0, measuredTokenRecords: 0, measuredCostRecords: 0 });
  const total = empty();
  for (const e of entries.filter((x) => x.at >= since)) {
    const modelSource = e.modelSource || "unverified";
    const requestedModel = e.requestedModel || "";
    const k = JSON.stringify([e.engine, e.model, e.role, modelSource, requestedModel]);
    const r = rows.get(k) || { engine: e.engine, model: e.model, role: e.role, modelSource, requestedModel, ...empty() };
    for (const t of [r, total]) {
      t.turns++;
      for (const field of ["input", "output", "cache", "reasoning", "cost"]) t[field] = add(t[field], e[field]);
      if (e.input == null && e.output == null) t.unknownTurns++;
      if (e.input != null && e.output != null) t.measuredTokenRecords++;
      if (e.cost != null) t.measuredCostRecords++;
    }
    rows.set(k, r);
  }
  return { rows: [...rows.values()].sort((a, b) => (b.output ?? 0) + (b.input ?? 0) - ((a.output ?? 0) + (a.input ?? 0))), total,
    note: "Includes Studio records and available recent NVIDIA worker reports for this product. Reported cost may differ from billed spend. External chat totals are unavailable." };
}
