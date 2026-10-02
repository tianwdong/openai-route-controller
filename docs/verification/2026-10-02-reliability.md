# Reliability verification — 2026-10-02

Scope: repository strategy and diagnostic logging; no live service deployment.

## Results

- `npm run verify`: 169 tests passed, zero failures or skips, plus JavaScript syntax checks.
- Local runtime: macOS, Node.js v25.8.1. Test duration was approximately 67 seconds.
- `sh -n scripts/install-macos.sh`: passed.
- `plutil -lint launchd/com.local.openai-route-controller.plist.template`: passed.
- `git diff --check`: passed.

## Reproduced and corrected boundaries

- A successful current-path probe previously cleared pool-outage observation
  despite pending passive errors; the controller-level regression now retains it.
- Recovery evidence no longer combines separate selection tenures, duplicate
  timestamps or observations retained across a process restart.
- One- and two-alternative pools can enter bounded outage recovery; malformed
  persisted cursors no longer yield undefined candidates.
- Pool retry delay cannot override the critical/active 60-second ceiling or the
  provider-failure 10/30/30-second schedule.
- Stronger fast-path qualification now precedes the two-slot limit. A regression
  with two high-ranked but recently failing paths confirms a later truly qualified
  standby remains reachable.
- Managed logs recreate the file after unlink or rename, rotate in order, bound
  queued bytes and retention, and continue routing after local write errors.
- Process-level fixtures confirm shadow logging leaves an existing live log
  untouched and live startup failures flush to the managed file without duplicate
  stdout. Both installers include the new module and separate bootstrap stdout.

## Limits

- Windows installer wiring is covered by static tests; no Windows host deployment
  or PowerShell execution was performed in this verification.
- Tests use local fixtures. No production selectors, subscriptions, services or
  active connections were changed. Passing fixtures is not proof that real Codex
  streams or the provider's upstream network have become stable.
- Rotation is not lossless auditing. Disk failure, queue overflow and abrupt
  termination can still lose log records; diagnostic stderr must be checked.

## Source fingerprints

SHA-256 of the verified runtime modules:

```text
2757ebbe8f9c5ef3b4d297889416df1bb3b6ec77061caa0425c77af5a893d10b  controller.mjs
265c2c3b5842626a288d5db196ed07c4a5b4fa2aa3ff77d2030b99162fc5cae3  lib.mjs
c6f29be512b864dbfc33ebeb7eae31f16d0ee7a160b25676d4157f528d45ceb1  logging.mjs
```
