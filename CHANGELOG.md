# Changelog

## 0.1.0 - 2026-09-03

- Added full OpenAI path probing instead of relying on short delay tests.
- Added rolling circuit breakers for consecutive, active, passive, intermittent,
  and slow failures.
- Added hot standbys, strict 3-probe qualification, 4-probe post-switch
  validation, rollback, cooldown, and bounded recovery backoff.
- Added guarded reuse of cooling nodes when a hard failure exhausts the normal
  candidate pool.
- Added connection draining so old-route errors are not charged to a new node.
- Added macOS launchd and Windows Task Scheduler installers.
- Added agent-ready deployment, troubleshooting, security, and rollback docs.
