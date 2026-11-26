# Feature Contract: Studio Feedback & Correction Workflow

**Status**: Draft (awaiting founder approval)
**Product**: AI Org Studio (appsworld2027/ai-org-studio)
**Prototype reference**: docs/mockup.html (to be created)

---

## Why this feature

Founders need a **single place in Studio** to:
1. See what was delivered (preview link + QA evidence)
2. Give feedback in plain English ("make the button blue", "the list doesn't load offline")
3. Track the correction through AI Org (which agent, what model, status)
4. Test the revised result
5. Accept or request more changes

Today this requires manual GitHub comments and watching the Agents tab. The workflow must be explicit, testable, and recoverable.

---

## In scope

| Capability | Description |
|------------|-------------|
| **Founder review inbox** | A "Waiting for you" section in Studio listing delivered features with preview links and QA evidence |
| **Delivered feature preview** | One-click open of the Vercel preview (or prototype) for the delivered feature |
| **QA evidence panel** | Shows Quinn's test report, Rex's review verdict, gate status (passed/failed) |
| **Accept / Request corrections / Discuss** | Three founder actions: `/approve`, `/changes <text>`, `/discuss <text>` posted as GitHub comments |
| **Natural-language feedback + attachments** | Free-text feedback; paste/drag screenshots, logs, JSON |
| **Feedback → correction task** | Maya interprets feedback, creates `ai:fix` issue with structured task (what changed, AC IDs affected, reproduction steps) |
| **Agent assignment & tracking** | Dev assigned to fix; Quinn to re-test; Rex to review; Studio shows live status from GitHub |
| **Revision history & comparison** | Side-by-side diff of what changed between submissions; founder sees "v1 → v2" |
| **Independent QA & regression** | Quinn runs locked acceptance tests + exploratory; gate blocks resubmission until green |
| **Resubmission for acceptance** | Dev opens PR labeled `ai:founder-test`; Studio shows new preview; founder tests |
| **Founder conflict detection** | If founder gives contradictory feedback across sessions, Maya flags it with options |
| **Durable context & recovery** | All context in GitHub (issue + PR + comments); Studio checkpoints in Garage; surviving agent resume |
| **Duplicate-task prevention** | Maya checks for existing open fix issue for same feature + same feedback theme |
| **Model usage & session health** | Per-agent model, tokens in/out, cost, session stage, checkpoint age |

---

## Out of scope

- Real-time collaborative editing in Studio
- Video calls or screen sharing
- Mobile app (Studio works in browser on phone via Cloudflare tunnel)
- Multi-founder approval workflows (single founder for pilot)

---

## Acceptance criteria (ACs)

| ID | Given | When | Then |
|----|-------|------|------|
| AC-01 | A feature is delivered (labeled `ai:delivery`) | Founder opens Studio | Feature appears in "Waiting for you" with preview link and QA summary |
| AC-02 | Founder clicks preview | Preview opens in right panel | Real Vercel preview loads (or prototype if no deploy) |
| AC-03 | Founder clicks "View QA" | QA panel opens | Shows Quinn's test results (pass/fail per AC), Rex verdict, gate status |
| AC-04 | Founder types feedback + `/changes` | Submits | GitHub comment posted on delivery issue with `ai-org:feedback` tag; `ai:fix` issue created |
| AC-05 | Founder attaches screenshot | Submits | Attachment uploaded to Garage; linked in GitHub comment |
| AC-06 | Maya receives `ai:fix` issue | Runs | Creates structured task: affected ACs, reproduction steps, acceptance criteria for fix |
| AC-07 | Dev fixes + opens PR | PR labeled `ai:qa` | Quinn runs locked tests; Rex reviews; gate shows in Studio |
| AC-08 | All gates green | Loop advances | PR labeled `ai:founder-test`; preview URL appears in Studio |
| AC-09 | Founder tests revised preview | Clicks "Accept" | `/approve` comment posted; feature marked shipped; loop closes |
| AC-10 | Founder gives contradictory feedback | Maya detects | Conflict card shown with 2–4 options, one Recommended |
| AC-11 | Studio restarts mid-correction | Founder reopens | Previous feedback, fix issue, PR, and QA evidence all visible |
| AC-12 | Duplicate feedback submitted | Maya checks | Existing fix issue linked; no duplicate created |
| AC-13 | Any agent runs | Studio Agents tab | Shows agent name, model, stage, minutes, last action, tool |
| AC-14 | Session ends | Founder asks for report | Model usage table: agent, model, tokens in/out, turns, cost |

---

## User journeys

### Journey 1: Happy path — accept first delivery
1. Feature delivered → `ai:delivery` label added
2. Studio shows in "Waiting for you" with preview + QA
3. Founder clicks preview → tests → clicks "Accept"
4. `/approve` posted → feature shipped → loop closes

### Journey 2: Correction needed
1. Feature delivered → founder sees bug
2. Founder types "The delete button doesn't work offline" + `/changes`
3. Maya creates `ai:fix` issue with AC references
4. Dev fixes → PR → Quinn tests → Rex reviews → gates green
5. `ai:founder-test` PR → new preview in Studio
6. Founder tests → accepts → shipped

### Journey 3: Contradictory feedback
1. Session 1: "Make the button red"
2. Session 2: "Make the button blue"
3. Maya detects conflict → shows options: Red / Blue / Keep current / Custom
4. Founder picks → Maya updates fix issue

---

## Edge cases (MANDATORY per product thinking)

| Edge case | Handling |
|-----------|----------|
| Network fails during preview load | Show cached prototype; retry button; offline banner |
| Founder closes browser mid-feedback | Draft saved in Garage; restored on reopen |
| Quinn's tests flaky (pass then fail) | Gate requires 2 consecutive passes; Rex flags flakiness |
| Dev's PR breaks unrelated feature | Regression tests catch it; gate fails; fix required |
| Model quota exhausted mid-run | Agent pauses; resume workflow retries hourly; Studio shows "paused — quota" |
| Two founders (future) give different feedback | Conflict detection per founder; merge requires explicit resolution |
| Attachment too large (>10MB) | Reject with clear message; suggest compression |
| Preview URL expires (Vercel preview TTL) | Studio detects 404; shows "Preview expired — rebuild?" button |

---

## Security & privacy

- **No secrets in feedback**: Attachments scanned for API keys, tokens; auto-rejected if found
- **Garage stays private**: All AI-made files go to studio-garage (must be private repo)
- **Founder comments signed**: GitHub comments use founder's account via `gh issue comment`
- **Model usage logged**: Tokens, cost per agent — no PII
- **No paid APIs**: Only free-tier (NVIDIA NIM) + user's own Claude/Codex plans

---

## Resilience & UX

| Scenario | UX |
|----------|----|
| Slow network | Skeletons for preview/QA; progressive load; 30s timeout → cached view |
| Repeated taps on "Accept" | Idempotent: second tap shows "Already submitted" toast |
| App closed mid-test | Session checkpoint saved; resume shows "You were testing Feature X" |
| Empty state (no deliveries) | "No features waiting for review — AI Org is working on [next item]" |
| Error state (GitHub API down) | Banner: "Cannot reach GitHub — showing last known state"; retry button |

---

## Model assignments (from team.mjs)

| Agent | Role | Model tier | Preferred model |
|-------|------|------------|-----------------|
| Maya | AI PM (feedback interpretation, task creation) | Deep | Claude Opus / Codex |
| Arjun | CPTO (architecture decisions on conflicts) | Deep | Claude Opus / Codex |
| Dev | Coding Specialist (implements fixes) | Standard | Codex / Nemotron |
| Quinn | QA Specialist (runs locked tests) | Standard | Nemotron / Codex |
| Rex | Code Reviewer (verdict on PR) | Careful | Different model from Dev |
| Kiran/Leela | PMs (coordination) | Light | Fast free model |

**Hard rule**: Rex never uses same model as Dev (enforced in team.mjs).

---

## Test feature for pilot

**Feature slug**: `feedback-workflow`
**Scope**: A minimal "Review Inbox" panel in Studio that:
- Lists delivered features from GitHub (`ai:delivery` label)
- Shows preview link + QA summary
- Accepts feedback via `/approve` `/changes` `/discuss`
- Creates `ai:fix` issue via Maya
- Tracks through to `ai:founder-test` and acceptance

This feature *is* the pilot — we build it using the AI Org, then test it by using it.

---

## Definition of Done (pilot complete)

- [ ] Founder can submit feedback through Studio on a real delivered feature
- [ ] AI Org (Maya → Dev → Quinn → Rex) executes the correction autonomously
- [ ] Independent QA (Quinn) verifies revised work with locked tests
- [ ] Studio presents revised result for acceptance
- [ ] All ACs above pass with real evidence (not mocks)
- [ ] Model usage recorded and reported
- [ ] studio-garage visibility resolved (private or documented)

---

## Change log

| Date | AC | Change | Founder decision link |
|------|-----|--------|----------------------|
| 2026-11-26 | — | Initial draft | — |