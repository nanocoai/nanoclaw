# Deferred ND Expense credential gate

No ND Expense token or OpenRouter credential has been stored by this playbox
work. Cloudflare remote staging, integration provisioning, OneCLI injection,
and egress-lockdown acceptance remain explicitly deferred.

## Intended credential

- OneCLI display name: `ND Expense Staging`
- Exact allowed host:
  `ndexpense-api-staging.smartecom.workers.dev`
- Header: `Authorization`
- Format: `Bearer {value}`
- Value source: the one-time output from the approved backend staging
  provisioning command

Enter the value only in OneCLI's masked credential UI. Never put it in a shell
argument, environment variable, `.env`, repository file, report, or chat.
The MCP server neither constructs an Authorization header nor accepts a token,
host, account, organization, or URL in tool input.

## Required verification before readiness

After the backend staging deployment and Task 8 authorization:

1. Verify the pinned OneCLI CLI/gateway and healthy gateway container.
2. From the agent container, request
   `/v1/agent/intakes/pending` on the exact staging host and expect 200.
3. Verify the production ND Expense host, an unrelated HTTPS host, metadata
   addresses, and private-network addresses are denied and receive no
   credential.
4. Set `NANOCLAW_EGRESS_LOCKDOWN=true` and repeat the permitted OpenRouter and
   staging ND Expense calls plus all denials.
5. Inspect only host, path, and status in logs; never headers or bodies.
6. Run live receipt acceptance and staging app visibility checks.
7. Only then create the owner-only
   `/var/lib/nanoclaw-household/.config/nanoclaw/onecli-ready` sentinel.

The backend's staging rollout commands and synthetic E2E are documented at
`/home/ndexpense/.config/superpowers/worktrees/ndexpense/agent-workflow/docs/runbooks/receipt-agent-backend.md`.

## Rotation and revocation

To rotate:

1. Remove the readiness sentinel and stop NanoClaw.
2. Provision a replacement staging integration only after re-verifying the
   fixed user, organization, and membership.
3. Add the replacement value through the masked UI with the same exact host
   scope.
4. Repeat injection, denial, lockdown, and live acceptance.
5. Revoke the old backend integration, remove its OneCLI credential, and verify
   the old credential no longer works.
6. Restore the readiness sentinel and start exactly one NanoClaw unit.

To revoke during an incident, first remove the readiness sentinel and stop both
units, then revoke the backend integration and delete the OneCLI credential.
Preserve non-secret audit metadata (credential name, host scope, timestamps,
operator, and reason), never the value.
