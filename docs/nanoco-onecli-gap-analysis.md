# NanoCo replacement coverage

This recipe removes OneCLI from NanoClaw's active runtime graph. Dormant
upstream setup/source/package residue remains until the recipe engine supports
reversible deletion, but NanoCo is the only session egress and approval path.
This document records capability gaps; it is not a fallback plan.

## Covered by the current NanoCo path

| Former capability | NanoCo replacement | Evidence |
|---|---|---|
| Keep reusable service credentials out of the agent | Gateway-owned encrypted credentials are selected by exact origin and retrieved only after policy Allow | Gateway credential integration tests |
| Force requests through a proxy | Agent is attached only to an internal per-session network and receives `HTTP_PROXY` / `HTTPS_PROXY` for `sidecar:15001` | NanoClaw sidecar lifecycle tests and Docker E2E |
| Authenticate the caller at egress | Short-lived client mTLS certificate resolves through an active fingerprint lease to immutable session lineage | Gateway session-channel integration tests |
| Agent-specific policy enforcement | Gateway resolves current governance role at request time and evaluates Cedar through PDP/PEP | Gateway session-channel proxy path |
| Prevent agent identity spoofing | Gateway ignores/removes agent, session, channel, container, owner, and proxy-auth headers on the sidecar listener | Loopback TLS tests and Docker E2E |
| Isolate concurrent work | One sidecar upstream connection per agent connection and one sidecar lifecycle per session | Gateway concurrency tests and NanoClaw lifecycle tests |
| Revoke live access | Lease revocation rejects reconnects and closes registered live Gateway connections | Gateway revocation integration test |
| Session certificate enrollment | NanoClaw generates the private key and CSR locally; the Gateway signs only after deployment mTLS authentication and a durable lease commit | Real control API TLS test and Docker E2E |
| Durable lease renewal | NanoClaw renews halfway to expiry with compare-and-swap lease versions; stale versions fail closed | Gateway API and NanoClaw lifecycle tests |
| Production listener activation | `nanoco-gw` can run legacy compatibility, sidecar data mTLS, deployment control mTLS, and local operator surfaces together | Gateway app wiring and configuration |
| Request-scoped human approval | The separate `nanoco-gateway-approvals` recipe consumes snapshot + SSE over deployment mTLS, durably routes the policy-selected approver, and submits an idempotent decision; Gateway re-evaluates policy and identity before forwarding | Gateway Ask tests and NanoClaw approval-adapter tests |

## Not covered yet

| Capability that users previously received | Current gap | Required owner / decision |
|---|---|---|
| Turnkey credential onboarding | NanoClaw no longer asks for or stores Anthropic/API credentials, but the Gateway has no operator-facing credential provisioning UX in this slice | Gateway control plane |
| Initial deployment enrollment | The local Gateway operator API can bind a pre-issued deployment certificate fingerprint, but one-time enrollment-code issuance and rotation UX are not implemented | Gateway control plane |
| Production governance role and owner | Development activation requires explicit `NANOCO_GW_DEV_SESSION_ROLE`; there is no production role/owner resolver yet | Governance milestone |
| OAuth connection flows | No NanoCo OAuth onboarding, refresh, or account-link lifecycle exists | Credential platform milestone |
| Per-credential rate limits | No parity layer has been added beyond what current Cedar policy expresses | PDP/governance design |
| Credential assignment UI | No UI or CLI maps a Gateway credential to agents/roles | Gateway operator surface |
| Remote hosted service discovery | Setup no longer installs or discovers a third-party proxy; NanoCo endpoint distribution is undefined | Deployment/product decision |
| Crash reconciliation | Local orphan cleanup exists, but revoking remote leases lost during a host crash needs a control-plane reconciliation API | NanoClaw/Gateway control plane |
| Digest-pinned image distribution | A minimal image builds locally; registry publication, signing, multi-arch builds, and deployment digest pinning are not defined | Release engineering |
| Physical legacy deletion | Dormant OneCLI setup files and dependency metadata remain in the composed OSS checkout even though the active host graph cannot construct or call OneCLI | Recipe-engine reversible deletion |

## Fail-closed consequence

NanoClaw starts an agent only when the complete NanoCo deployment/control/data
configuration is present. Missing or partial configuration, issuance failure,
renewal failure, sidecar exit, lease expiry, and revocation all fail closed.
There is no direct-egress or former-proxy fallback. Deployment enrollment,
digest-pinned image publication, crash reconciliation, and the production
Governance boundary remain deployment gates.
