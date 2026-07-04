# Security Policy

Thanks for helping keep nanoclaw and its users safe. This page explains how to
report a vulnerability, what we consider in scope, and how we decide whether a
report is a security vulnerability or a hardening improvement.

It is the reporting-and-triage policy. For the architecture it builds on — the
trust model, the container-isolation boundary, mount security, and credential
isolation — see the security overview at
**<https://docs.nanoclaw.dev/concepts/security>** (the canonical, source-verified
threat model), with the details in `/operate/hardening` and `/operate/credentials`.
That page defines what nanoclaw trusts and distrusts; this one defines how we
handle reports against those boundaries.

## Reporting a vulnerability

**If you believe you have found an exploitable vulnerability, report it
privately. Do not open a public issue.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/nanocoai/nanoclaw/security/advisories/new)**
(Security tab → Report a vulnerability). This opens a private advisory visible
only to you and the maintainers.

If you cannot use GitHub, you can reach the maintainers privately — ask in the
[Discord](https://discord.gg/nanoclaw) for a private contact rather than posting
details in a public channel.

We aim to acknowledge a report within a few days and to keep you updated as we
triage, fix, and coordinate disclosure. Valid reports are credited in the
advisory unless you ask otherwise.

## What to include

A report we can act on has:

- **A minimal, reproducible proof of concept** — the concrete steps, message, or
  input that triggers the issue. If we cannot reproduce it, we cannot confirm it
  is exploitable, and we cannot fix it with confidence.
- **The affected version** (the nanoclaw version or commit you tested against).
- **The impact** — what an attacker gains, and **which trust boundary it
  crosses** (see the trust model at <https://docs.nanoclaw.dev/concepts/security>).
- **Your setup**, if it matters — channel type, provider, whether the affected
  group is the main group or a non-main group.

The reproduction must plausibly occur on a **correctly configured, production
nanoclaw deployment**, driven only by input an attacker actually controls. A
report that only works after you change nanoclaw's own source, run it in an
unusual local-development configuration, or grant the attacker access they would
not normally have is, by definition, not demonstrating a vulnerability in
nanoclaw (see Out of scope).

## In scope

The core question: **can an attacker who only controls untrusted input cross one
of nanoclaw's trust boundaries on a correctly configured deployment?** For
example:

- A container escape — agent code reaching the host, or another group's files or
  session, past the mount and isolation boundaries.
- Real credentials or secrets reaching a container (they are designed never to).
- Data crossing the group boundary — a non-main group reading or acting on a main
  group's data, or one session's data leaking into another.
- Untrusted inbound channel input (a message, an attacker-controlled sender)
  gaining an authorization, action, or capability it should not have.
- Bypassing the mount allowlist to read a blocked path.

## Out of scope

These follow directly from the trust model — they assume access the attacker is
not supposed to have, or misuse the system rather than breaking it:

- **Anything requiring host or root access** on the machine running nanoclaw. An
  attacker who already has that can do worse than attack nanoclaw.
- **Anything requiring modification to nanoclaw's own source** to become
  reachable. Building something vulnerable on top of nanoclaw is not a
  vulnerability in nanoclaw.
- **A malicious or misconfigured skill, mount, or operator configuration.** The
  operator and what they choose to mount are trusted; the mount allowlist is
  theirs to set.
- **Prompt-injecting an agent you already control** in your own group. Agents
  treat inbound messages as untrusted input by design; getting your own agent to
  misbehave is not a boundary crossing.
- **Issues only reproducible in local development** (for example a
  development-only configuration that is not how production runs).
- **Theoretical reports with no working reproduction**, or reports whose only
  reproduction path is direct access to the host, the database, or the process.

If your finding falls here but still improves nanoclaw's resilience, it is very
welcome as a **hardening** report — see below.

## Security vs. hardening

Not every security-relevant improvement is a vulnerability. We use the same
distinction Node.js and others use:

- A **security vulnerability** crosses a trust boundary (In scope, above), is
  reproducible, and works on a correctly configured deployment. Handled
  privately, may receive an advisory/CVE.
- A **hardening** (defense-in-depth) improvement makes nanoclaw more resilient
  *after another boundary has already failed*, or reduces risk without a
  demonstrated boundary crossing. These are real and valuable, but they are
  **not** treated as vulnerabilities: they are handled as regular issues, get no
  advisory or CVE, and are labelled **Hardening**.

If you are not sure which one you have, that is fine — say so, give the
reproduction, and we will make the call during triage. When in doubt about
whether something is sensitive, report it privately first.

## A note on AI-assisted reports

AI tools are welcome as an aid, but a human has to stand behind the report.
**If you used an AI tool to find or write up an issue, say so, and make sure you
have personally verified that the issue is real and reproducible before
submitting.** Explain it in your own words. Reports that are unverified AI output
— long, confident, and not actually reproducible — slow down triage for
everyone, and we may close them without a detailed response. Repeatedly
submitting unverified low-quality reports may lead us to decline future reports
from that source.

## How we triage public security issues

If an issue is filed publicly under the **Security** label without a working,
in-scope reproduction, a maintainer will ask for what is missing and point here.
If the required reproduction is not provided, we may relabel it (often to
**Hardening**) or close it with a comment explaining why — **you can always
re-open it, or file a new report, once you have a reproduction that meets this
policy.** Closing is a maintainer decision with a stated reason, not an automated
rejection. Genuinely sensitive findings belong in a private report, not a public
issue.
