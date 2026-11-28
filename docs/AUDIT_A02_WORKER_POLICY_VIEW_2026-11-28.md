# A-02 — Studio worker policy visibility (draft)

Audit finding: Studio Team settings and actual GitHub Actions model selection were disconnected. Org draft #174 derives worker choices from the canonical AUTONOMY_POLICY.json; this companion draft reads the policy from the configured handbook's exact Git commit.

- Team API provides a revision-bound workerPolicy object plus a founder-visible note. Local recommendations and local key availability remain explicitly advisory; no claim is made about GitHub credentials, quota, qualification, actual usage or live execution.
- Missing, malformed or inconsistent policy returns unavailable, without inventing a worker route from the local catalog. No provider calls. No production policy writes, no live Garage changes, and no security remediation.
- Garage team-model export description corrected: advisory memory, not worker authority.
- Tests: missing module initially failed; four targeted tests then passed. Actual read-only GitHub API smoke decoded the configured policy from main at 6a6693ab41daaabe4d5138591bf9860c568c7010. Full Studio suite: 186 passed, 0 failed, 1 dependency-gated skip (node-pty/ws not installed locally); hosted CI must independently run.
- Limitations: not a deployment, not live runtime admission, and not a claim that model choice or provider entitlement is verified. Studio local preferences cannot modify the background-worker policy. Keep draft until approved independent review and product delivery qualification.
