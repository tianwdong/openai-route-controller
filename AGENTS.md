# AGENTS.md

## Scope

This repository contains a local Mihomo route controller for OpenAI, ChatGPT,
and Codex traffic. Keep changes limited to that route. Do not add unrelated
application rules or provider-specific subscriptions.

## Safety

- Never commit proxy subscription URLs, node endpoints, API secrets, account
  cookies, access tokens, logs, state files, or machine-specific paths.
- Keep the Mihomo HTTP controller bound to loopback only.
- Do not weaken candidate qualification, post-switch validation, cooldown, or
  rollback checks merely to make a test pass.
- Installation changes user services. Run verification and shadow mode before
  loading launchd or Windows Task Scheduler entries.

## Development

- Require Node.js 22 or newer and avoid runtime dependencies when possible.
- Preserve macOS Unix-socket and Windows loopback-HTTP transports.
- Add or update focused tests for every circuit-breaker state transition.
- Run `npm run verify` before delivery.
- Keep documentation consistent with the constants in `controller.mjs`.
