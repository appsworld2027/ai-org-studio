# Agent execution evidence

## Founder-facing meaning

An assignment or workflow title is a routing signal, not proof that a model ran.
A successful run is not proof that its output was accepted or that another
agent consumed it. Studio separates these evidence levels.

- The **Founder Inbox** shows an execution timeline for the supervised synthetic
  pilot. Actual model requests, HTTP responses, parsed responses, tool requests
  and outcomes, artifacts, and founder acknowledgements are recorded.
- The **Agent board** reads recent GitHub workflow jobs and relevant steps for
  the selected product. It links to the exact run and distinguishes an active
  engine step from setup, a handover check from a receiving agent's receipt,
  and inferred workflow attribution from identified role execution.

## Local metadata journal

The preview writes **`$STUDIO_HOME/founder-pilot/execution-events.jsonl`**.
Every line is a timestamped JSON event with a request ID, revision, event ID
and (for execution events) execution ID. The file is created owner-only and
events are flushed before returning. Only allowlisted metadata is appended:
role, model, round, tool name/outcome, status, duration, reported token counts,
error category, and SHA-256 contract digest. No raw prompts, founder feedback,
credentials, tool arguments/output, or HTTP bodies are written to the journal.
Missing provider usage/model metadata is unknown, not zero or guessed.

A saved contract is logged before a handoff is offered. A founder acknowledgement
must refer to the same execution ID and artifact digest for an instrumented
contract. A revision can reference a prior contract digest and correction count.
A failed or interrupted run is not counted as complete. Prior uninstrumented
runs stay uninstrumented; there is no backfilled proof. The journal is local
persistent evidence, not a tamper-proof external audit service, and does not
survive loss of the underlying home directory.

## Canonical AI Org workflow evidence

The existing reusable AI Org agent-worker records routing, onboarding, engine
execution, validation, handover checks, and logs in GitHub Actions. Studio
links observed run/job/step statuses. A green handover check is evidence that
a producer's packet passed validation—not that the next agent read it. A
successful chaining step similarly is not a receipt.

For live multi-agent coordination, the canonical worker must emit a producer
handoff and a separate consumer receipt with the same work-item ID, immutable
artifact digest/commit, producing and receiving agent/run IDs and timestamps.
Only that matched pair should be labelled confirmed coordination. The local
pilot proves only the Maya-to-founder handoff, not Arjun, Quinn, Dev or Rex
delivery. The canonical worker integration remains disabled until approved
and demonstrated end-to-end. Studio does not deploy or merge automatically.

## Validation

`node --test test/founder-pilot.test.mjs test/execution-journal.test.mjs`
covers metadata-only logging, read/blocked tools, durable revision state and
matched acknowledgement, and the distinction between active workflow and
verified receiving-agent receipt. Tests use stand-in model responses; a live
preview test is still needed to prove provider connectivity and instrumentation.
