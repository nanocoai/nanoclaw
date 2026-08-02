# Household expense playbox acceptance

## Local gate result

Local deterministic acceptance passed on 2026-08-02:

```text
mode: local-deterministic-double
passed: 12
failed: 0
```

The machine-readable report was written owner-only to
`/tmp/expense-agent-playbox-report.json`. It contains scenario names, pass
states, and durations only; it contains no chat body, message ID, receipt ID,
media, credential, or prompt.

Run the same gate with NanoClaw stopped so the harness can own the loopback
playbox port:

```bash
cd /srv/nanoclaw-household
bun test scripts/verify-expense-agent.test.ts
bun scripts/verify-expense-agent.ts --local-double \
  --base-url http://127.0.0.1:3210 \
  --report /tmp/expense-agent-playbox-report.json
```

The primitive tests prove immutable-message-ID correlation despite unrelated
and out-of-order SSE events, a 120-second scenario deadline, diagnostic
redaction, and duplicate backend-row rejection. The scenario runner uses the
real loopback `PlayboxServer` request validation, attachment materialization,
delivery/SSE protocol, duplicate transport guard, and fault queue. A
deterministic in-process conversation/API double supplies model and ND Expense
outcomes.

All twelve approved workflows passed:

1. Clear image auto-save with complete confirmation.
2. Incomplete text, one clarification, and exactly one save.
3. Total correction reflected by the local app-query double.
4. Ordered two-receipt batch.
5. Independent valid save plus one unclear batch item.
6. Exact-source resend idempotency with the prior outcome.
7. Concurrent Alice/Bob outcome isolation.
8. Unrelated text ignored and Guest denied.
9. Parser timeout, API 429, and API 500 retryable outcomes followed by
   idempotent recovery.
10. Recent receipt and monthly/category/vendor summary parity.
11. Trash and restore with no permanent-delete operation.
12. English and Traditional Chinese language-matched confirmations.

## Scope boundary

This is the local playbox acceptance gate, not live integration acceptance.
The deterministic double intentionally replaces only the unavailable external
boundaries; it does not prove an OpenRouter model call, OneCLI credential
injection, the deployed Cloudflare staging Worker, D1 persistence, or staging
mobile/web visibility. The normal Task 7 routing smoke separately proved
`playbox → router → Household Expense Agent` and strict Guest denial before
container wake stopped at the deferred OneCLI credential gate.

When Cloudflare staging and credentials are authorized, rerun the harness
without `--local-double` after implementing the live transport, then inspect
one image receipt and one text-only receipt in the staging app, including edit,
Trash, and restore. Until then the CLI refuses implicit live mode and exits
non-zero instead of silently substituting a fake.

Real WhatsApp pairing remains deferred until the dedicated household number is
available.
