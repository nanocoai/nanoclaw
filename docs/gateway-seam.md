# Gateway Provider Seam

A **credential gateway** is the component that holds real secrets and injects
them at the network boundary, so no credential ever enters an agent container.
NanoClaw does not implement one. It defines a seam, selects exactly one
provider per install, and owns everything about that provider's behavior that
is a NanoClaw concern: session lifecycle, human approval, reconciliation, and
the realization of whatever the provider contributes to a container spec.

This document is the contract. For which gateways exist and how one gets
installed, see [skills-model.md](skills-model.md) and the `/add-<gateway>`
skills.

## Why a seam and not a dependency

The gateway is the single most security-relevant dependency in the system and
the one most likely to differ per deployment — a hosted vault, a local proxy,
something an enterprise already runs. Baking one in made three things true that
should not be: its native protocol leaked into the spawn path, its approval
semantics were NanoClaw's approval semantics, and its container flags rode
around spec validation as raw argv.

The seam inverts all three. A provider **translates its native protocol** and
manages only resources it owns. Everything else is core's.

## The contract

`src/gateway-providers/gateway-provider-registry.ts` is the whole interface.

```ts
interface GatewayProviderDefinition {
  kind: string;
  agentSkills: readonly string[];
  sessions: {
    ensure(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease>;
    reapOrphans?(): void | Promise<void>;
  };
  approvals: {
    legacyActions?: readonly string[];
    subscribe(decide: Decider, signal: AbortSignal): Promise<void>;
  };
}
```

**`ensure` is idempotent.** Core calls it for new and adopted sessions. The
`disposition` distinguishes creation from adoption: an adapter must not create
replacement identity for a runtime that survived a host restart. Core invokes
optional `reapOrphans` only after it has considered surviving runtimes.

The signal stops the current host's observation. Existing install-scoped
adapters can retain their signal cleanup. Adapters owning per-session resources
implement the lease's awaited `release({ kind, reason })`: `session-ended`
releases resources after runtime termination; `host-detached` stops observation
but preserves resources for a successor. A failed runtime stop also detaches,
because the runtime may still be alive. Core releases the session claim before
awaiting cleanup so a cleanup failure cannot leak the claim.

**The lease's `contribution` is typed.** `env`, `mounts`, `containers`, lineage `labels`, and a
`networkAccess` intent — never raw runtime flags. It is merged
into the `SessionSpec` _before_ validation, so admission judges the whole
session including the gateway's part of it. A provider that emits argv natively
parses it at its own boundary and fails the spawn on anything it cannot type.

**`networkAccess` is an intent, not a topology.** `{ kind: 'host' }`,
`{ kind: 'runtime', identity }`, or `{ kind: 'session-container', role }`. The
driver realizes it (`src/drivers/index.ts`) or rejects it. Egress lockdown
(`src/egress-lockdown.ts`) accepts only `runtime` targets, because only a named
runtime object can be attached to the internal network.

**Approvals are a subscription, not a workflow.** `subscribe` translates the
provider's native events into `GatewayApprovalRequest` and awaits a decision.
It never talks to a channel, never touches `pending_approvals`, and never
decides anything itself.

Core supplies an installation scope to subscriptions. Adapters reading a shared
native event stream must check `scope.ownsAgentGroup` before translation, age
checks, or any decision. Foreign requests and failed ownership lookups must leave
the native request untouched, not deny it. OneCLI implements this using the pinned
SDK callback's documented failure behavior: a thrown callback submits no decision.
Owned requests still pass every core validation and approval check.

## Default model-traffic approvals

`GatewayApprovalRequest.trigger` distinguishes a `default` network hold from an
explicit `policy` hold. Missing triggers retain human approval for older adapters.
A default hold supplies a validated `destination.host` and an active session.
Provider host contracts also declare `modelEndpoints` for API, subscription, and
OAuth-token URLs. Credential adapters resolve those URLs through
`getProviderModelEndpoint`; the network allowlist derives model hosts from
`providerModelAllowedHosts`. No adapter owns a provider-domain exception list.
Endpoint URLs must use HTTPS within that provider's declared domains. Missing
endpoint declarations fail explicitly; missing domains confer no exemption.

Core resolves the session's pinned agent provider, falling back to its group
configuration, and reads `ProviderHostContract.modelDomains`.

Requests to those HTTPS domains (including subdomains) receive automatic approval
for all paths and methods. This includes SDK discovery, telemetry, and provider
hosted app/MCP traffic. Other destinations and explicit policy holds retain human
approval. Missing declarations never imply open access. Provider packages declare
their own domains; gateway adapters must not keep model-host lists or interpret
presentation text to make approval decisions.

Core validates identity, session ownership, freshness, expiry, and bridge health
before approving. Network restrictions and credential grants still apply. Native
gateway denials must not be converted into default holds. Native explicit approval
rules use `policy`; gateways that already permit model traffic need not fabricate
an approval event. OneCLI's native approval events are explicit policy holds;
Iron's generic network holds are default holds.

## What core owns

`src/gateway-approval-coordinator.ts` implements the one human approval flow
every gateway gets, so the flow cannot differ by provider:

- Validation and size limits on every field of a translated request.
- Validating the agent group and active session ownership. Non-durable adapters
  deny requests created before this host started; durable adapters recover only
  requests whose full binding matches the persisted record.
- Approver resolution (`pickApprover`) and delivery (`pickApprovalDelivery`).
- The `pending_approvals` row, the card, the click authorization, the terminal
  card edit, and the sweep of rows a previous host left behind — including rows
  written by an older adapter version, via `legacyActions`.
- A pending ceiling and a deadline capped independently of what the provider
  asked for.

No failure path approves. With `approvals.durable: true`, the adapter must
implement `listPending` and `decide`. Core persists the card and decision before
external delivery, retains decisions until the gateway acknowledges them, and
retries after restart. An uncertain delivery is not sent again. A changed request
binding cannot reuse an existing approval.

Durable adapters distinguish `unavailable` from a human denial. An outage must
not turn an undecided request into a permanent policy decision. The adapter may
select an exact approver and delivery instance; core still owns authorization,
expiry, persistence, and terminal card updates. Typed presentation fields use a
registered renderer and fail closed when no matching renderer is installed.

## Availability is a state, not a verdict

The bridge is supervised. If `subscribe` ends — cleanly or by rejection —
the coordinator settles holds as denied (or unavailable for durable adapters), closes session admission
(`stopGatewaySessionsForUnavailability`), stops the running sessions, and
resubscribes with capped exponential backoff. A retry that survives its
fail-fast window reopens admission (`resumeGatewaySessionAdmission`).

When approval handling and session admission run in separate processes, the
provider can implement `availability.publish` and `availability.read`. Only the
approval owner publishes health. Every host observes it without starting another
approval subscription. The provider must store health as a bounded lease: absent,
expired, or unreadable state is unavailable. Core refreshes health every five
seconds and checks it every second, with a five-second read timeout. A failed
observer check closes admission; a later healthy lease reopens it. Gateways that
do not declare this capability retain the single-process behavior.

This matters more than it looks. Closure is fail-closed by design — a session
whose credentials cannot be authorized must not run — but it must not be
terminal. A host that stays up while permanently refusing to spawn anything
drops every user message with only a log line to show for it, which is strictly
worse than crashing, because nothing restarts it.

## Selection

One provider per install, chosen by `NANOCLAW_GATEWAY_PROVIDER` and resolved
once at startup by `getGatewayProvider()` — before the DB opens, so a
misconfigured install fails immediately rather than at first spawn.

Registration is a single side-effecting import appended to
`src/gateway-providers/installed.ts`, the same shape as the driver and
provider-container-config barrels. With no provider registered, the host
refuses to start: there is no implicit default and no open-egress fallback.

Only the selected gateway's `agentSkills` reach an agent
(`selectGatewayAgentSkills`), so a container is never told about a gateway it
is not behind.

## How a gateway gets installed

Gateway skills are the one skill type that keeps its implementation on `main`,
in the skill's own `payload/` directory, rather than on a registry branch. The
reason is bootstrapping: a channel can be added later, but an install with no
gateway cannot start at all, so the payload has to be present in the checkout
that setup is running from.

A gateway skill is any `.claude/skills/<name>/` directory containing a
`gateway.json`:

```json
{ "kind": "onecli", "label": "OneCLI", "description": "…", "default": true }
```

`setup/gateways/catalog.ts` discovers them by that file and requires exactly one
`default`. OneCLI is currently the default and appears first in the advanced
setup picker; simple setup keeps it without an extra choice. Existing installs
retain their selected gateway. Changing the manifest default can change the
fresh-install preference later without changing provider login.

`setup/gateways/install.ts` applies the chosen skill through the
normal skill engine — same `nc:` directives, same journal — and stamps
`NANOCLAW_GATEWAY_PROVIDER`. The skill's `scripts/detect.ts` prints `installed`
or `absent`, which is what lets `/update-nanoclaw` recognise an install that
predates the seam and reapply its gateway before cutover
(`scripts/update/transaction.ts`).

The payload lands in ordinary paths — `src/gateway-providers/<kind>.ts`,
`container/skills/<kind>-gateway/` — and registration is one appended line in
`src/gateway-providers/installed.ts`. Nothing outside that directory is
rewritten to install a gateway.

## Mount class `gateway-trust`

Public CA material a MITM gateway needs the agent to trust. Pinned by path to
the install's `data/gateway-trust/` root, forced read-only, and — unlike
`identity-material` — permitted in the agent role, because a public
certificate is not a credential. The pinning is what makes the distinction
checkable rather than a labelling convention: a private key placed under
`materialsRoot` cannot be relabelled `gateway-trust` to get itself mounted into
an agent.

See [api-details.md](api-details.md) for the full mount taxonomy.

## Agent-provider credentials

Provider login prompts stay in the provider's existing `runAuth` hook. A
provider calls `getCredentialStore()` to resolve the selected gateway's
`scripts/credential-store.ts`; it never shells out to a named gateway.
The gateway module exports `createCredentialStore(root)` with `has(provider)`
and `save(provider, credential)`. Credentials are either an API key or a
protected file from a dedicated OAuth login. The provider deletes temporary
login files after transfer. The gateway owns storage, refresh, grants, and
its credential-free session contribution. Missing adapters fail explicitly;
there is no fallback to a different gateway. This changes neither setup's
screens nor its step sequence.


## Account connection is separate from request approval

`ncl groups connect --host <hostname>` is a read-only, group-scoped handoff to
`GatewayProviderDefinition.connections.connect`. Core validates the group, host,
and returned URL; adapters return only `GatewayConnectionResult`. There is no
site catalog in core. The handoff cannot write credentials, grants, or network rules.

`action_required` includes a real `connect_url` and an action: `operator_console`
requires operator configuration; `oauth` represents a gateway-provided consent
flow. Neither means connected. Missing adapter support returns `unsupported`.
A credentialed API call must succeed before an agent reports success. A 401 or
403 alone cannot distinguish missing, rejected, or expired credentials from policy.

Iron supplies its official operator console for any hostname. It does not currently
provide a single-use account onboarding link; this contract does not pretend it does.
OneCLI can return its configured `ONECLI_CONSOLE_URL`; native connect_url responses
remain valid. No dashboard location is guessed from an API server address.


### Operator-approved REST reads

`NANOCLAW_GATEWAY_READ_ONLY_HOSTS` is a comma-separated list of exact API
hostnames whose GET/HEAD requests need no human card. It is empty by default.
For example, `api.github.com` enables GitHub REST reads across paths. Configure
only services whose GET/HEAD semantics the operator accepts as read-only.
This is a core approval rule, shared by all gateways, not a credential grant
or an egress allowlist. Those gateway checks still apply independently.

Adapters provide the HTTP method in `destination.method`. Core applies the
rule only to `trigger: default`, after validating the live session and request
identity. Explicit policy holds are never exempt. Missing methods, writes,
GraphQL POSTs, subdomains, nonstandard ports and malformed configuration do not
match. Changing `.env` applies to subsequent requests; restart the host when
changing a process-environment override. OneCLI's explicit native policy holds
remain authoritative.


### Approval presentation

Gateways may supply `summary` with `agent`, `action`, `resource`, `reason`,
and bounded labeled `details`. Core validates and escapes these fields and
uses one renderer for both the human card and the saved approval. Legacy
adapters retain their `title`/`question` fallback. Malformed summaries fail
closed. These fields are display-only and cannot alter authorization.

Adapters must supply only safe display metadata: no raw request bodies,
headers, credentials or query strings. OneCLI uses its native action summary
when available; raw body previews are not forwarded. Iron’s NanoClaw front reuses the same pinned OneCLI summarizer, including its application registry
and generic fallback. HTTP POST alone is not evidence of a specific write action.
The common card states that approval applies to one request and does not
connect an account or expand credential permissions.

### OneCLI approval compatibility is an invariant

Approval action descriptions, selected details, application coverage, and generic
fallback must match the pinned OneCLI gateway. Adapters must not introduce their
own per-site descriptions or special cases. Both installed adapters normalize
OneCLI-shaped summaries through `normalizeGatewayApprovalSummary` and use the
same renderer. Identity validation, routing and decisions remain core-owned.

OneCLI supplies its native summary. The Iron adapter runs the same pinned OneCLI summary
modules and provider registry inside its NanoClaw-owned approval front, before
forwarding approved requests to unmodified upstream Iron for credential injection.
The front authenticates session identities and checks every request inside HTTPS
tunnels. Only explicit continue decisions are accepted; bridge outages, malformed
responses, timeouts and session revocation fail closed. Iron listens only on
loopback in the same container, with dial-time loopback restrictions preventing
backend access through DNS aliases. Control-plane sync cannot replace the front.
Credentialed application traffic uses HTTPS; the Iron adapter preserves the
request scheme and rejects plaintext HTTP rather than treating it as HTTPS. Its helper receives a 16 KiB body prefix and no authorization headers;
only the resulting summary crosses the approval channel. The original request
stream is preserved. The source is checksum-verified, its upstream tests run in
the image build, and a version mismatch against OneCLI's gateway pin fails the
build. See `gateway-compat/onecli-summary/README.md`.
