# Changelog

## Unreleased

- Kept pool-degradation retry bounds independent of one-off probe successes;
  pending faults, selection changes and restarts reset stable-recovery observation.
- Preserved critical/active and provider retry ceilings during pool-wide outages,
  including small candidate pools and safe persisted cursor defaults.
- Recognized multilingual subscription region labels and diversified qualified
  standbys; applied fast-path qualification before limiting recovery slots.
- Added asynchronous, bounded and rotating local logs to both platform installers;
  removed log files are recreated on the next event without restarting routing.
- Added regression coverage for pool transitions, admission ordering and log loss.

- Separated standby ranking and readiness from short-probe success counters,
  preserving complete-path failures when native delay tests turn green.
- Reserved one bounded exploration slot when no fast standby is ready, with
  persisted attempt history, unchanged concurrency, and failure/cooldown guards.
- Fixed passive-error recovery cancelling itself after qualifying candidates and
  successful short probes clearing an unresolved passive-error backoff.
- Made manual selection and confirmed network changes advance current monitoring
  deadlines, including changes discovered by an in-flight check.
- Added elapsed-time API deadlines and rejection of truncated responses.
- Guarded observed external selections and live-probe attribution; reconciled
  uncertain selector writes with four-success validation.
- Removed shared native health and delay admission gates from recovery and hot
  standby checks, so stale cache no longer requires manual speed-test refreshes.
- Added historical sequence, transport, scheduling, and recovery race regressions.

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
