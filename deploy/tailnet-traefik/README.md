# Private tailnet ingress

The target topology is deliberately one-way and origin-preserving:

```
tailnet HTTPS :443       -> tailscaled -> 127.0.0.1:18080 -> Governance
tailnet HTTPS :9080-9085 -> tailscaled -> 127.0.0.1:18090-18095
                           -> dedicated Traefik -> Backlot listener Services
tailnet HTTPS :19081      -> tailscaled -> 127.0.0.1:18101
                           -> dedicated Traefik -> one claimed child's Slack service
```

The installer disables K3s's packaged `traefik` AddOn through a config drop-in;
that actively removes its public LoadBalancer and bundled CRD release. The
replacement therefore owns the pinned Gateway API CRDs, least-privilege RBAC
and one dedicated controller. Product routing is expressed with the standard
`Gateway` and `HTTPRoute` APIs; Traefik remains the replaceable implementation.
The pod uses `hostNetwork` only so it can bind node loopback. It has no
Kubernetes Service, NodePort, LoadBalancer or hostPort. In tailnet-only mode it
listens on no routable node address; neither Traefik nor Governance consumes
Tailscale identity headers.

When `--edge-domain <installation-domain>` is supplied, the same Deployment
also binds one non-loopback HTTP entrypoint (default `18000`) for an internal
ALB target. Infrastructure admits that port only from the ALB security group.
Terraform owns private wildcard DNS and TLS; this installer owns exact product
hostnames such as `governance.<installation-domain>`, while the child helper
owns `slack-<namespace-suffix>.<installation-domain>`. A flat label is deliberate: an ACM
certificate for `*.<installation-domain>` does not cover
`component.<namespace-suffix>.<installation-domain>`. The wildcard resolves names but grants
nothing: every hostname still needs an accepted exact `HTTPRoute`.

Each Backlot product already owns a complete origin: `/`, provider API paths,
OAuth redirects, absolute links and its WebSocket/SSE stream. The adapter
therefore gives control, Slack, Teams, Okta, Google and Salesforce distinct
HTTPS ports on the same tailnet hostname. It sets Backlot's existing
`BACKLOT_<PRODUCT>_PUBLIC_ORIGIN` contract and never strips prefixes, rewrites
paths or selects a backend with a cookie. For this development adapter the
public ports intentionally match Backlot's listener ports (`9080` through
`9085`); the private listeners remain ClusterIP-only.

After the box has joined the tailnet, the Recipes deploy driver invokes:

```sh
bash deploy/tailnet-traefik/install.sh \
  --tailnet-host omri-test.tailc2ca02.ts.net \
  --system-namespace system \
  --mocks-namespace mocks
```

Development profiles with a fixed `governanceDevelopmentActor` also pass
`--allow-loopback-only`. If Tailscale is unavailable, the installer still
creates and proves the node-loopback routes, reports `loopback-only=true`, and
skips every `tailscale serve` write. The deploy remains degraded and operator
access requires the trusted SSH path.

For an installation with a Terraform-provisioned private edge, the deliberate
deployment supplies the target-owned, non-secret domain without baking it into
the release or deriving it from Tailscale:

```sh
NANOCO_K8S_PRIVATE_EDGE_DOMAIN=omri-test.dev.nanoco.sh \
  bun ci/deploy-build.ts nanoco-k8s-kata --allow-remote
```

The deploy driver forwards that value as `--edge-domain`. Omitting it preserves
tailnet-only behavior; a scheme, port, path, uppercase label or wildcard is
refused before any target mutation.

The script applies the private controller and routes, proves every exact-host
loopback origin reaches the intended backend, then configures persistent
Tailscale Serve on HTTPS 443, 9080-9085 and the reserved child-Slack origin
19081. With a private edge domain, deploy also installs one wildcard
`HTTPRoute` backed by a strict child-edge router. A claimed
`governed-child-kata` automatically receives a namespace-local bridge; release
deletes it with the namespace. No operator command or per-child Gateway API
RBAC is required.

The helper remains available as a diagnostic/manual repair path:

```sh
bash deploy/tailnet-traefik/expose-child-services.sh \
  --namespace nanoclaw-dev-1234abcd \
  --tailnet-host omri-test.tailc2ca02.ts.net \
  --edge-domain nanoco-k8s-kata.dev.nanoco.sh \
  --governance-development-actor tailnet-development@nanoco.local
```

The automatic router accepts only exact
`slack|governance-nanoclaw-dev-<8 hex>.<installation-domain>` authorities and
derives one namespace-local bridge Service from that name. The bridge dials
the syncer's stable child Service DNS, never a cached ClusterIP, validates each
child TLS leaf against its public CA, and overwrites Governance's development
actor. Agent pods cannot reach Governance's dashboard port; explicit
NetworkPolicies leave Gateway as their only control-plane/egress door.

Governed children publish
`governance-<instance-namespace>.<installation-domain>` directly from the
Governance Bun server. Bun serves HTTPS with the child's existing Governance
identity leaf, and the namespace bridge verifies that leaf against the synced
Governance identity CA. The bridge overwrites `X-Forwarded-Email` with the deployment profile's single explicit
development actor, so callers on the private edge may perform audited
mutations without choosing their own identity. This is a development-only
shared identity; customer routes must replace it with OIDC/ForwardAuth.

Governance owns HTTPS 443 at `/` and binds its dashboard to the pod interface
only when the deployment declares this tailnet origin. A dedicated ClusterIP
Service and NetworkPolicy accept traffic only from the private Traefik
controller. A development profile may name one explicit
`governanceDevelopmentActor`; the standard Gateway API header filter overwrites
any caller-supplied `X-Forwarded-Email` with that actor, so every peer admitted
by the private network perimeter may perform audited mutations without
pretending to have per-user identity. Customer profiles leave the field null,
which keeps writes closed until an OAuth/OIDC proxy supplies the verified actor.
No Tailscale identity header is consumed.

## Deferred provider-neutral ingress

This skill is the first proven adapter, not the customer-wide exposure API.
Later LAN/WAN providers should keep the same private service contract while
replacing Tailscale with customer DNS/TLS and an OAuth/OIDC proxy. The proxy
must strip caller-supplied authentication headers, set `X-Forwarded-Email` from
the verified session, and become the only NetworkPolicy-admitted dashboard
caller. Agent-created HTTPRoutes and an NCL-native exposure provider are also
deferred until per-agent namespace, hostname/path, Gateway attachment,
admission, NetworkPolicy, quota and approval boundaries exist; this skill
grants no agent RBAC over Traefik resources.
