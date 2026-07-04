# Security triage guide (maintainers)

How to triage an incoming security report or a public issue filed under the
**Security** label. The contributor-facing rules live in
[`.github/SECURITY.md`](../.github/SECURITY.md); this is the maintainer playbook
behind them. It exists so severity calls are a shared test, not an argument each
time.

## The boundary test

Ask, in order:

1. **Is it reproducible?** If there is no working reproduction and you cannot
   produce one, it is not confirmed exploitable. Ask for a PoC; do not triage a
   theory as a vulnerability.
2. **Does it cross a trust boundary?** Check it against the trust model at
   <https://docs.nanoclaw.dev/concepts/security>. Does untrusted input (an inbound message,
   an attacker-controlled sender, a non-main group) gain a capability, action, or
   data it should not have — container escape, credential leak into a container,
   cross-group/session leak, mount-allowlist bypass?
3. **Does it work on a correctly configured production deployment, using only
   access the attacker actually has?** If it needs host/root access, a change to
   nanoclaw's own source, a malicious mounted skill, or an operator
   misconfiguration to become reachable, the attacker is starting from inside a
   boundary we trust — it is not a vulnerability.

**All three yes → Security vulnerability.** Handle privately (advisory), fix,
coordinate disclosure.

**Security-relevant but fails 2 or 3 (post-boundary, defense-in-depth, or only
reachable with pre-existing access) → Hardening.** Real and worth doing, but a
regular issue: **Hardening** label, no advisory, no CVE.

**Fails 1 with no path to a repro → close** with the constructive template below.

## Worked example: PR #2651 / issue #2923 (our own)

We ran this test on our own work, and it is a good calibration:

- **#2651** added an origin check so a forged `ask_user_question` response from a
  different channel is rejected. Real improvement — but reproducing the gap it
  closes requires forging a raw webhook/interaction event, i.e. host access or a
  webhook with no secret token. Through legitimate platform paths an attacker
  cannot emit an event carrying a questionId whose card they cannot see. **Fails
  test 3** (needs host/misconfig access). → **Hardening**, not a vulnerability.
- **#2923** (card can be visually defaced by a forged click before the origin
  check) is a display spoof — the forged answer is still rejected and never
  reaches the agent. Same host-access reproduction. **Fails test 2 and 3.** →
  **Hardening**, low priority.

Neither is a "security vulnerability" under this policy, and saying so on the
record is the point of having the policy.

## Handling a public "Security" issue

1. **In scope with a working repro?** Move it to private handling
   (open/convert to a security advisory), remove public exploit detail if
   sensitive, and proceed as a vulnerability.
2. **Security-relevant but Hardening?** Relabel **Security → Hardening**, set a
   priority, handle as a normal issue.
3. **Missing a required, in-scope reproduction?** Apply **needs-repro**, post the
   template below, and give the reporter time to respond. If it is not provided,
   close with a stated reason — **the reporter can re-open once they have a repro
   that meets the policy.** Closing is your decision with a reason, never a silent
   or purely automated reject.
4. **Unverified AI slop** (long, confident, not reproducible, undisclosed AI):
   close with a short pointer to `.github/SECURITY.md`. Repeated low-quality
   submissions from the same source are grounds to decline future reports.

## Comment templates

**Needs reproduction** (apply `needs-repro`):

> Thanks for the report. To triage this as a security issue we need a minimal,
> reproducible proof of concept that works on a correctly configured deployment,
> using only input an attacker controls — see our
> [security policy](../.github/SECURITY.md). Could you add the exact steps or
> input that trigger it, and the version you tested? If the reproduction requires
> host access, source changes, or a malicious mount/config, it is out of scope as
> a vulnerability, but may be a good **Hardening** report.

**Closing for no repro** (after a fair wait):

> Closing for now — we could not confirm an in-scope, reproducible issue against
> a correctly configured deployment (see the [security policy](../.github/SECURITY.md)).
> This is not a judgment that nothing is here: if you can share a working
> reproduction that meets the policy, please re-open this or file a new report
> and we will take another look.

**Reclassifying to Hardening:**

> Relabelling this as **Hardening**. It is a real resilience improvement, but it
> does not cross a trust boundary on a correctly configured deployment (it
> requires <host access / source changes / a malicious mount>), so under our
> [security policy](../.github/SECURITY.md) we track it as a defense-in-depth
> improvement rather than a vulnerability. Thanks — this is still welcome.

## Labels

- **Security** — confirmed or under-investigation vulnerability that crosses a
  trust boundary. Prefer private advisories; use the label only for issues that
  are already public or non-sensitive.
- **Hardening** — defense-in-depth / resilience improvement; security-adjacent
  but not a boundary crossing on a correct deployment.
- **needs-repro** — awaiting a reproduction before it can be triaged.
