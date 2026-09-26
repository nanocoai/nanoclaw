# Official Iron Control

Source of truth for this skill:

- [Iron Control README at the pinned revision](https://github.com/ironsh/iron-control/blob/6fe857654376d67d100400bbd26c31540effb127/README.md)
- [API at the same revision](https://github.com/ironsh/iron-control/blob/6fe857654376d67d100400bbd26c31540effb127/docs/API.md)
- [Console routes](https://github.com/ironsh/iron-control/blob/6fe857654376d67d100400bbd26c31540effb127/config/routes.rb)

The public deployment docs describe the separate console service. The pinned
source controls exact endpoints and available screens: API paths start with
`/api/v1`, and credential assignment uses principals and grants.

## Add an app credential and policy

For GitHub REST access, create a Static Secret in the official Secrets screen.
Use the Control Plane source to store the token encrypted in Iron Control, set
an Authorization header with formatter `Bearer {{ .Value }}`, and scope the
request rules to `api.github.com`, the intended repository paths, and the
needed HTTP methods. For example, `GET` and `/repos/OWNER/REPO/*` provide a
limited reading policy. This does not install a GitHub channel or MCP server.

Copy the secret's `ssr_…` identifier and run the skill's `control.ts grant static`
command. It uses Iron's native API and the local administrator credential file;
no token is passed as a command argument. To permit the destination at the
network boundary, run `setup.ts --allow-host api.github.com`. Refresh preserves
the console, principal, proxy token, and encryption keys.

Inspect Principals → NanoClaw to see its effective credential grants. The
current upstream UI edits secret rules but does not create principals or
grants; setup and the helper use the documented API for those operations.

Google consent apps are supported in OAuth Apps. This is separate from console
SSO. Do not describe it as a Codex or arbitrary app sign-in catalog. Codex uses the shared provider login flow and Iron’s native credential broker,
not an OAuth Apps entry. Its refresh token stays in Iron Control; only the
current access token and account header reach Iron Proxy.

## Verify

1. The console's `/up` endpoint returns HTTP 200 and `/login` shows the official
   Iron login form. Only the configured loopback port is published.
2. The proxy log reports managed mode and a successful initial sync. Its
   registered proxy and principal IDs match `registration.json`.
3. A request with an unknown signed session identity gets HTTP 403.
4. A known session app request waits for NanoClaw approval. Denial, an unavailable
   bridge, and invalid identity do not contact the upstream.
5. After approval, only a matching granted credential is injected. Repeat after
   a control-plane update to verify the local approval prefix still runs.
   Check both approval callbacks contain no headers, bodies, query strings,
   or transform traces; injected credentials must never return to NanoClaw.

Use an isolated local test upstream and a disposable credential for the last
two checks. Do not send test messages or writes to a real app.

## Data and upgrades

`control.env` holds the operator bootstrap and encryption keys; `proxy.env`
holds this proxy's control-plane token; `login.txt` holds operator sign-in
details; `image.json` records how the console image runs on this engine (the
pinned amd64 image, that image under emulation, or a local build for another
architecture). Files are mode 0600 inside a mode 0700 directory. Back up these files
and the install-scoped PostgreSQL volume together. Recreating containers does
not recreate keys or the database.

The control-plane image and database image are pinned by digest. On an engine
that is not amd64 the control-plane image is instead built from the pinned
upstream revision, labelled with that revision, and recorded in `image.json`;
the database image is multi-architecture and stays pinned by digest. The native
proxy build uses unmodified upstream source and is pinned by source commit plus the separate NanoClaw approval-front hash. Do not
replace it with a generic managed-mode image: managed updates would remove
NanoClaw's local identity and approval transforms.

On failure, keep the old proxy running where possible; inspect the isolated
Compose project's logs and fix the reported issue. Do not clear the database,
regenerate encryption keys, or fall back to open egress.

## Model traffic and human approval

Iron forwards default network holds to NanoClaw's shared approval coordinator.
Core uses the active agent provider's declared model domains for automatic
approval, including telemetry and provider-hosted MCP calls. The bridge keeps no
model-host or endpoint exemption list. See [the shared contract](../../../../docs/gateway-seam.md#default-model-traffic-approvals).

Identity verification, the destination allowlist, and Iron credential grants
remain enforced. Other app destinations retain human approval. Explicit gateway
policy holds must be marked as policy holds and are never covered by the default
model exemption.
