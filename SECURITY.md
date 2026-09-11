# Security Policy

## Reporting a Vulnerability

If it could be exploited on a normal, correctly configured install, do not open
a public issue. [Report it privately](https://github.com/nanocoai/nanoclaw/security/advisories/new)
through GitHub's private vulnerability reporting. A maintainer applies
`kind/security` only when disclosure is safe.

Public defense-in-depth ideas that are **not** exploitable vulnerabilities go
through the [Security hardening issue form](https://github.com/nanocoai/nanoclaw/issues/new?template=security-hardening.yml)
instead.

## Security model

The threat model, trust boundaries, and container-isolation details live in
[docs/SECURITY.md](docs/SECURITY.md); the canonical, continuously-verified
version is at [docs.nanoclaw.dev/concepts/security](https://docs.nanoclaw.dev/concepts/security).
