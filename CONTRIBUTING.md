# Contributing

Bug reports should include the operating system, Mihomo version, controller
event names, and an anonymized timeline. Remove node endpoints, subscription
URLs, secrets, account cookies, and personal paths.

Before submitting a change:

1. Keep it within OpenAI／ChatGPT／Codex routing scope.
2. Add focused tests for circuit-breaker behavior changes.
3. Run `npm run verify` with Node.js 22 or newer.
4. Run `controller.mjs --once --shadow` against a local Mihomo instance.
5. Update the README or architecture document when a default threshold changes.

Do not submit threshold changes based on a single provider, node, or short
latency test. Prefer anonymized multi-hour evidence from the complete OpenAI
path.
