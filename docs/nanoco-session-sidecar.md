# NanoCo per-session sidecar boundary

Status: NanoCo is the only active runtime egress implementation. The sidecar
image is buildable, the deployment-mTLS certificate/lease control client is
implemented, and a real Docker agent/sidecar/Gateway mTLS test passes.

## Replacement semantics

`src/session-egress.ts` is the single egress selection point used by the
container runner. `registerNanoCoSessionSidecar()` registers the NanoCo factory.
Without that registration, agent startup is rejected; there is no direct or
legacy proxy fallback.

This is a replacement boundary, not a proxy chain.

## Session lifecycle

For every agent session, NanoClaw:

1. Generates a unique container-instance ID and channel ID.
2. Asks `SessionChannelProvisioner` for one short-lived channel bound to the
   exact deployment, agent, session, container instance, and channel lineage.
3. Creates an internal agent/sidecar network and a separate sidecar-only uplink
   network.
4. Starts the sidecar with its client certificate and key mounted read-only.
5. Starts the agent only on the internal network with
   `HTTP_PROXY=http://sidecar:15001` and
   `HTTPS_PROXY=http://sidecar:15001`.
6. Stops the agent if the sidecar exits or the local lease deadline passes.
7. Revokes the channel, removes the sidecar and networks, releases the
   certificate material, and only then permits that session to restart.

Host shutdown waits for the same cleanup. Startup removes install-labeled
containers and networks left by a prior process crash.

## Security boundary

The agent receives the public proxy CA only. It does not receive the sidecar
certificate, private key, Gateway credential, Docker socket, host gateway, or
direct internet route. Provider-supplied proxy variables are superseded by the
trusted session-egress contribution, and the Docker network boundary remains
fail closed even for software that ignores proxy environment variables.

The sidecar runs read-only with all Linux capabilities dropped and
`no-new-privileges`. Its output is not relayed into NanoClaw logs. Provisioning
and Docker failures crossing the lifecycle boundary are reduced to sanitized
error categories.

The certificate identifies a session channel only. Role, owner, approval
authority, policy permissions, and upstream service credentials are not part of
the NanoClaw lineage contract.

## Control-plane seam

`SessionChannelProvisioner` is deliberately narrow:

- `provision(lineage)` returns Gateway location, lease metadata, public proxy
  CA, and sidecar-only mTLS material.
- `revoke(channel, reason)` makes the lease unusable and closes its active
  Gateway connections.
- `release(channel)` destroys local certificate material.

`GatewaySessionChannelProvisioner` implements this contract against the
Gateway's deployment-mTLS session-channel control API. It generates the private
key locally, submits only the CSR, validates the exact returned lineage,
certificate/key match, lease version, and expiry, and redacts control failures.

## Real Docker boundary test

`src/nanoco/docker-gateway.e2e.test.ts` builds the Gateway-owned
`Dockerfile.sidecar`, starts the real Gateway mTLS listener, creates both Docker
networks through `DockerSessionSidecarDriver`, starts the sidecar with mounted
session material, and runs a separate curl agent container on the internal
network.

The test proves the request succeeds without `Proxy-Authorization`, the
Gateway observes the expected five lineage IDs, agent-provided identity headers
are stripped, and close revokes/releases the channel and removes the sidecar.
It is opt-in because it requires Docker and both checkouts:

```sh
NANOCO_DOCKER_E2E=1 \
NANOCO_GW_CHECKOUT=/absolute/path/to/nanoco-gw \
pnpm exec vitest run src/nanoco/docker-gateway.e2e.test.ts
```

## Decisions still required

- The production registry and digest-pinned delivery path for the
  `nanoco-sidecar` image. The current Dockerfile pins the build toolchain by
  tag; deployment must pin the resulting image digest.
- Crash reconciliation that revokes remote leases whose local process state was
  lost; certificate expiry remains the backstop until that API exists.
- Physical removal of dormant upstream OneCLI setup/source/package residue once
  the recipe engine supports reversible file deletion. It is not reachable from
  the active host runtime after the recipe is applied.
