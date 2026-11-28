# Proposed Garage mirror guard - not deployed

The current live Garage mirror synchronizes all branch/tag refs and prunes
remote refs. This proposal is deliberately not a Studio workflow and does not
write to either Garage. It authorizes only a non-force exact main ref, using
an immutable SHA, after live checks of the exact private GitHub source, its
current main SHA, exact GitLab project ID/path/HTTPS URL, private visibility,
no shared groups, and a complete member listing containing only the verified
owner. The destination is compiled in, not controlled by a variable.
No tag, other branch, force, deletion, redirect or automatic push retry.
Before a push the live target main SHA is checked; an exact match is a no-op.
Afterward the exact target SHA must be observed. Pre/post checks report uncertainty without leaking provider bodies or tokens.

Run synthetic tests: cd ops/garage-mirror && python3 -m unittest -v test_guard.py
Tests stub requests and pushes; they do not use live credentials or write
memory. The .yml.example is inactive on purpose. To deploy requires review of
the narrowed backup policy (main only), exact current GitHub/GitLab settings,
branch protection/workflow access, credential scope and GitLab group
privacy policy preventing unauthorized visibility changes. A last-moment
privacy change is a residual race; postflight detects but cannot undo a push.
A failed or ambiguous push requires reconciliation, not automatic retry.
A scheduled run first reconciles actual target main before any fresh non-force
push; the immutable commit and ref make an exact match a no-op.

Before Studio writes can be enabled, independently review and deploy the
guard in Garage, remove broad ref synchronization, prove a synthetic
private-target write/recovery with disposable data, and provide an
authenticated runtime privacy and reviewed-workflow verifier. Until then
Studio remains fail-closed for active mirrors. No production activation.
