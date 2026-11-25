// Unit tests for the Studio's agent board logic. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBacklog, stageOf, slugOf, buildBoard, feedFrom, appTarget } from "../server/status.mjs";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const BACKLOG = `# Product backlog
- [x] coach-needs-you — Coach "Needs you" list on Today — M2-41
- [ ] needs-you-fees-overdue — Overdue fees in Needs you — M2-41
- [ ] parent-quick-signals — Parent quick signals — M2-06
`;
const issue = (n, title, labels, extra = {}) => ({ number: n, title, html_url: `https://g/${n}`, labels: labels.map((name) => ({ name })), ...extra });

test("parseBacklog reads done and open items with their roadmap ids", () => {
  const b = parseBacklog(BACKLOG);
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { slug: "coach-needs-you", title: 'Coach "Needs you" list on Today', ref: "M2-41", done: true });
  assert.equal(b[2].done, false);
});
test("slugOf reads issue titles and loop branch names", () => {
  assert.equal(slugOf("Discovery: Overdue fees [needs-you-fees-overdue]"), "needs-you-fees-overdue");
  assert.equal(slugOf("ai/contract-needs-you-fees-overdue"), "needs-you-fees-overdue");
  assert.equal(slugOf("ai/fix-needs-you-fees-overdue-12"), "needs-you-fees-overdue");
  assert.equal(slugOf("QA lab nightly: failing checks"), null);
});
test("stageOf maps loop labels to who acts; later stage and blocked win", () => {
  assert.deepEqual(stageOf(["ai:discovery"]), { label: "ai:discovery", stage: "contract", who: "Maya, product manager", kind: "agent" });
  assert.equal(stageOf(["ai:founder-decision"]).kind, "founder");
  assert.equal(stageOf(["ai:delivery", "ai:release"]).label, "ai:release");
  assert.equal(stageOf(["ai:release", "ai:blocked"]).kind, "blocked");
  assert.equal(stageOf(["bug"]), null);
});
test("buildBoard: backlog rows, the live item's stage, waiting-for-you, next item", () => {
  const b = buildBoard({ backlog: parseBacklog(BACKLOG), issues: [issue(42, "Discovery: Overdue fees [needs-you-fees-overdue]", ["ai:founder-decision"])], runs: [] });
  const row = b.rows.find((r) => r.slug === "needs-you-fees-overdue");
  assert.equal(row.stage, "approve"); assert.equal(row.kind, "founder");
  assert.equal(b.rows.find((r) => r.slug === "coach-needs-you").kind, "done");
  assert.equal(b.waiting.length, 1);
  assert.equal(b.next.slug, "parent-quick-signals");
  assert.equal(b.working.length, 0);
});
test("buildBoard: furthest item wins (contract PR at release beats the discovery issue)", () => {
  const b = buildBoard({ backlog: parseBacklog(BACKLOG), issues: [
    issue(42, "Discovery: Overdue fees [needs-you-fees-overdue]", ["ai:tests"]),
    issue(50, "Contract: Overdue fees", ["ai:delivery", "ai:release"], { pull_request: {}, branch: "ai/contract-needs-you-fees-overdue" }),
  ], runs: [] });
  const row = b.rows.find((r) => r.slug === "needs-you-fees-overdue");
  assert.equal(row.stage, "demo"); assert.equal(row.kind, "loop"); assert.equal(row.items.length, 2);
});
test("buildBoard: non-backlog loop items get their own row (e.g. a QA-lab fix)", () => {
  const b = buildBoard({ backlog: [], issues: [issue(43, "QA lab nightly: failing checks", ["ai:fix"])], runs: [] });
  assert.equal(b.rows.length, 1); assert.equal(b.rows[0].kind, "agent"); assert.equal(b.rows[0].who, "Dev, builder (fixing)");
});
test("buildBoard: a running agent run is attributed to the item it works on", () => {
  const now = Date.parse("2026-11-23T10:40:00Z");
  const b = buildBoard({ backlog: parseBacklog(BACKLOG), now,
    issues: [issue(42, "Discovery: Overdue fees [needs-you-fees-overdue]", ["ai:tests"])],
    runs: [{ name: "AI agents", status: "in_progress", display_title: "Discovery: Overdue fees [needs-you-fees-overdue]", run_started_at: "2026-11-23T10:35:00Z", html_url: "https://r/1" },
           { name: "QA lab (personas + journeys + probes)", status: "in_progress", run_started_at: "2026-11-23T10:30:00Z", html_url: "https://r/2" },
           { name: "AI agents", status: "completed", display_title: "AI agents" }] });
  assert.deepEqual(b.working[0], { who: "Quinn, tester", what: "Overdue fees in Needs you", minutes: 5, url: "https://r/1" });
  assert.equal(b.working[1].who, "QA lab"); assert.equal(b.working[1].minutes, 10);
  assert.equal(b.working.length, 2);
});
test("buildBoard: Demo Pack preview is picked up from a founder-test PR", () => {
  const b = buildBoard({ backlog: parseBacklog(BACKLOG), issues: [issue(50, "Contract: Overdue fees", ["ai:delivery", "ai:founder-test"], { pull_request: {}, branch: "ai/contract-needs-you-fees-overdue" })],
    previews: { "ai/contract-needs-you-fees-overdue": "https://pp-git-x.vercel.app" } });
  assert.deepEqual(b.demo, { feature: "Overdue fees in Needs you", url: "https://pp-git-x.vercel.app", number: 50 });
  assert.deepEqual(appTarget({ productionUrl: "https://prod", demo: b.demo }), { kind: "preview", url: "https://pp-git-x.vercel.app", label: "Preview: Overdue fees in Needs you" });
});
test("appTarget: production when no demo, none when no Vercel (prototype only)", () => {
  assert.equal(appTarget({ productionUrl: "https://prod" }).kind, "production");
  assert.equal(appTarget({}).kind, "none");
});
test("feedFrom: agent and founder lines in plain words; Vercel bot noise dropped", () => {
  const f = feedFrom(fx("comments.json"));
  assert.ok(f.length >= 4);
  assert.ok(f.every((x) => !/\[vc\]/.test(x.text)));
  assert.ok(f.some((x) => x.text.startsWith("Kiran:")));
  assert.ok(f.some((x) => x.text === "You approved"));
  assert.ok(f.every((x) => x.text.length <= 160));
});
test("real snapshot of Parent Plus (23 Nov) renders a sensible board", () => {
  const issues = fx("issues.json"), runs = fx("runs.json").workflow_runs;
  const backlog = parseBacklog(Buffer.from(fx("backlog.json").content, "base64").toString());
  const b = buildBoard({ backlog, issues, runs, now: Date.parse(runs[0].run_started_at) + 60000 });
  const fees = b.rows.find((r) => r.slug === "needs-you-fees-overdue");
  assert.equal(fees.stage, "tests"); assert.equal(fees.who, "Quinn, tester");
  assert.ok(b.rows.some((r) => /QA lab nightly/.test(r.title) && r.kind === "agent"));
  assert.equal(b.rows.find((r) => r.slug === "coach-needs-you").kind, "done");
  assert.ok(b.working.length >= 1);
  // The 23-Nov run was dispatched by the loop with a generic title; two agents were busy, so it must not guess.
  assert.equal(b.working[0].who, "An AI agent"); assert.match(b.working[0].what, /Quinn.*Dev|Dev.*Quinn/);
});

test("founder overview reports observed delivery and exact workflow evidence", () => {
  const result = buildBoard({
    backlog: [{ slug: "done", title: "Completed", done: true }, { slug: "next", title: "Upcoming" }],
    issues: [
      { number: 1, title: "Choice", labels: ["ai:founder-decision"], assignees: [{ login: "owner" }] },
      { number: 2, title: "Blocked", labels: ["ai:founder-decision", "ai:blocked"] },
    ],
    runs: [
      { name: "Quality", status: "completed", conclusion: "failure", head_sha: "abc", html_url: "https://example.test/1" },
      { name: "Quality", status: "in_progress" },
    ],
  });
  assert.deepEqual(result.overview, { completed: 1, ongoing: 1, blocked: 1, upcoming: 1 });
  assert.deepEqual(result.decisions.map(({ number, assignees }) => [number, assignees]), [[1, ["owner"]]]);
  assert.deepEqual(result.quality, [{ name: "Quality", conclusion: "failure", commit: "abc", url: "https://example.test/1" }]);
});
