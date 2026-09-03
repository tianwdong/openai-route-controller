# Security Policy

This project controls a local proxy selector and can read Mihomo connection and
warning-log metadata. It must not receive ChatGPT credentials, proxy
subscription URLs, node endpoints, or account cookies.

## Safe defaults

- macOS uses Clash Verge Rev's local Unix socket.
- Windows uses an explicitly enabled Mihomo External Controller bound only to
  `127.0.0.1`.
- The Windows secret is stored with current-user DPAPI encryption and restricted
  file permissions.
- Runtime state, logs, local settings, and secret files are ignored by Git.

## Reporting

Use GitHub private vulnerability reporting when available. Do not open a public
issue containing secrets, subscription data, node addresses, raw logs, or local
account paths. Sanitize diagnostics before sharing them.
