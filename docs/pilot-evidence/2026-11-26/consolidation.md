# Studio integration consolidation — 26 November 2026

- Canonical branch: integration/ai-org-studio; draft PR #18.
- GitHub checkpoint 91b8d52 integrated. Local pilot reviews and OpenCode adapter preserved in fa6dcab; merge c680549 retains original-suite amendment plus locked-suite readiness validation. Repaired runtime and static route: 9689616. Older stash retained locally and archived as a patch in 1b3aec6.
- Supervised repairs BUILD-10 and BUILD-11 were deterministic ChatGPT-assisted corrections, not successful autonomous Dev output; exact hash and provenance are in supervised-repair-manifest.json.
- Legacy alternate delivery-feedback prototype: feature/feedback-workflow at 4a7d122, independently committed and pushed. This is intentionally not activated in the pilot runtime because it is an earlier, separate GitHub-backed implementation, not the reviewed local feedback candidate. Do not discard it.
- Locked suite SHA256: 666b870f7eb1a64080e8ef4952c304451f7e22f4a48fc8d3a3175b53e24e69ba. Clean archived source at 1b3aec6 passed 4/4 with isolated Node permission harness and simulated fsync only for the denied journal sync operation. Physical crash durability not established.
- Regression fixture pinned to original pre-build source (be49a0d). Full npm test then passed 133/133 with empty environment and scratch HOME.
- Existing independent QA and Rex receipts APPROVE the supplied reviewed candidate. Separate task-isolation check passed 1/1 on that candidate. Browser smoke test saved a local task and two revisions, retained them across page reload, and recorded zero model requests; a stale load-error message and hardcoded journal label remain to be fixed. Browser test ran on isolated preview, not the final exact commit.
- No paid model routes or unattended live execution enabled; no production deployment or main merge. Next: resolve the two browser defects and validate the live agent-led correction cycle before release.
