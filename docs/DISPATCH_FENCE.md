# Durable Studio task dispatch fence

A GitHub issue POST can succeed even if Studio never receives its response. A
retry is unsafe unless the exact request marker confirms the previous outcome.
Studio writes a private, fsynced, write-once claim before the first POST. The
file name and value are SHA-256 fingerprints (no founder text or secrets).
Separate adapters, server restarts and cooperating processes sharing the same
durable STUDIO_HOME cannot independently claim the same request. Existing
confirmed issues are fenced on recovery too. Missing, corrupt, conflicting or
unavailable storage, and an uncertain POST with no visible issue, hold rather
than automatically repeat dispatch. Claims are intentionally not auto-expired
or deleted: reconciliation must establish the exact remote outcome.

Deployment constraint: this establishes idempotency only for controllers
sharing the same private durable POSIX filesystem and its O_EXCL/fsync
semantics. Do not run independent Studio dispatch writers on separate volumes;
a cross-host installation requires a verified shared atomic claim backend.
The fence covers issue submission, not downstream agent task leasing,
authorization, or the complete product development lifecycle.
