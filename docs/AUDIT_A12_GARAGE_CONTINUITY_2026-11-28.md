# A-12 — Garage continuity and truthful turn completion

Status: deterministic candidate; no live deployment.

Observed source baseline b75bf96883ff1793d94928abb79ffa5234178ffa:
- Studio free chat pulled Garage before reserving a turn; the pull swallowed failure and returned no receipt. Stale shared memory could silently be passed to a model.
- At turn end, Studio released the busy flag and emitted idle before invoking asynchronous Garage save; an overlapping turn or service interruption could precede checkpoint completion.
- Studio Garage main 42296abe8742bcf8c67279bbcdef51e62697871f contains product memory and a fictional qualification checkpoint plus runtime receipt schema. This proves persisted artifacts exist, not automatic recovery of a live autonomous session.

Candidate:
- Return explicit pull status, configured/available flags and local HEAD on success; do not claim remote durability from a local HEAD. Serialize pull with the existing save queue within one Studio process.
- Reserve free chat before pulling; configured Garage retrieval failure pauses the model call. For an unconfigured Garage, preserve free-chat availability with an explicit missing shared-memory note. Do not record a failed preflight as a completed turn.
- Await journal and save receipt before releasing free-chat reservation and idle event. Scope the assistant response to this turn, never a previous reply. Surface a non-durable checkpoint note on failure. Do not change privacy verification, credentials, Git push/rebase strategy, mirror configuration or paid engines.
- Official engine-chats still use their old lifecycle; this fix targets the requested free-chat route. Multi-host concurrency and interrupted partially written work require later reconciliation, accepted review and actual live testing.

Evidence:
- Expected red recovery test: pull returned undefined; repaired using a genuine temporary bare Git repo and second clone, local-only transport, remote decision fetch, outage and recovery.
- Five added tests (one real Git recovery/outage and four lifecycle tests); all 7 targeted pass including original two Garage sync tests.
- Complete local Studio suite: 180 passed, 0 failed, 1 skipped (billing server test depends on installed ws/node-pty); hosted CI with full dependencies/browser remains required.
- No provider requests, user product changes or live Garage writes. All fixture data fictional. Actual unattended cloud worker delivery, exact-head independent review, cross-session real product recovery and founder laptop-closed verification remain outstanding.
