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

## Later

- [ ] Add Linux service packaging after a verified reference installation.
- [ ] Add an opt-in local status summary without exposing node endpoints or
  secrets.
