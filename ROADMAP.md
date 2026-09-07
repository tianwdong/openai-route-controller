# Roadmap

## v0.1

- [x] OpenAI full-path probing and passive transport-error detection.
- [x] Rolling failure windows, cooldown, hot standby, strict candidate
  qualification, post-switch verification, rollback, and bounded backoff.
- [x] macOS Unix-socket integration and launchd installer.
- [x] Windows loopback External Controller integration and Task Scheduler
  installer.
- [x] Agent-ready deployment instructions and rollback documentation.
- [ ] Validate the Windows installer on a clean Windows 10 and Windows 11 host.
- [ ] Collect anonymized multi-provider stability reports before changing the
  default breaker thresholds.

## v0.2

- [x] Keep synthetic provider failures out of real OpenAI path history and
  reset incompatible state.
- [x] Refresh a bounded, diverse subset of stale provider candidates when the
  provider-alive pool collapses.
- [x] Cap provider-outage backoff at 30 seconds and wake recovery when a hot
  standby becomes ready.
- [x] Preserve established OpenAI streams across route changes by draining old
  connections naturally and attributing their errors to the old route.
- [x] Detect macOS default-network transitions, suppress route-change noise,
  revalidate the current node, and optionally repair per-service system proxies.
- [x] Prioritize severe faults over intermittent windows, let newly escalated
  faults interrupt mild backoff, and cap active or severe retries at 60 seconds.
- [x] Rank real path evidence by recency-weighted reliability and reduce one
  historical penalty level after sustained recovery without shortening isolation.
- [x] Probe candidates through loopback listeners bound directly to each node;
  require full qualification and immediate preflight before live selection.
- [x] Build hot-standby full-path history without live switches, retain readiness
  across duplicate successful samples, and repair cold-radar delay parameters.
- [x] Cover isolated preflight, bad response bodies, standby readiness, backoff
  escalation and penalty recovery with focused tests and local API integration.
- [x] Preserve recent passive transport failures across successful short probes
  and verify that expired failures do not trigger recovery.

## Later

- [ ] Add Linux service packaging after a verified reference installation.
- [ ] Add an opt-in local status summary without exposing node endpoints or
  secrets.
