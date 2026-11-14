---
name: add-k8s-driver
description: Add the generic Kubernetes Jobs SessionDriver to NanoClaw when agent sessions must run as short-lived in-cluster Jobs instead of Docker containers.
---

# Add Kubernetes SessionDriver

This skill installs the out-of-tree `kubernetes` driver. It owns only Job/Pod realization and registration; cluster RBAC, NetworkPolicies, PVCs, agent groups, triggers, approvals, and workload-specific policy stay with the deployment.

## Install the driver

Copy the driver and its focused tests into NanoClaw:

```nc:copy
payload/src/drivers/kubernetes-driver.ts -> src/drivers/kubernetes-driver.ts
payload/src/drivers/kubernetes-driver.test.ts -> src/drivers/kubernetes-driver.test.ts
```

Append its self-registration import to the driver barrel:

```nc:append to:src/drivers/installed.ts
import './kubernetes-driver.js';
```

## Configure the runtime

Set `NANOCLAW_RUNTIME_DRIVER=kubernetes` only in an in-cluster NanoClaw deployment. The driver reads the mounted ServiceAccount token, namespace, and cluster CA. Optionally set:

- `NANOCLAW_KUBERNETES_NAMESPACE` to override the Pod namespace.
- `NANOCLAW_KUBERNETES_SERVICE_ACCOUNT` for session Pods; otherwise Kubernetes uses the namespace default.
- `NANOCLAW_KUBERNETES_IMAGE_PULL_POLICY` to `Always`, `IfNotPresent`, or `Never` (default `IfNotPresent`).
- `NANOCLAW_KUBERNETES_MOUNTS` to a JSON object that maps NanoClaw host paths either to PVC subpaths or content already present in the agent image. Set it whenever session specs declare mounts, as normal NanoClaw sessions do.

Example mount configuration:

```json
{
  "persistentVolumeMounts": [
    { "hostRoot": "/srv/nanoclaw/data", "claimName": "nanoclaw-data", "claimSubPath": "data" },
    { "hostRoot": "/srv/nanoclaw/groups", "claimName": "nanoclaw-data", "claimSubPath": "groups" }
  ],
  "bakedSurfaces": [{ "hostRoot": "/srv/nanoclaw/container/agent-runner/src", "containerRoot": "/app/src" }]
}
```

Every declared session mount must match one mapping, and host roots must not overlap. A baked surface is accepted only when its configured container path exactly matches the `SessionSpec`; all other mounts become explicit PVC `volumeMounts`.

## Validate

```nc:run effect:build
pnpm run typecheck
```

```nc:run effect:test
pnpm exec vitest run src/drivers/kubernetes-driver.test.ts
pnpm exec vitest run src/drivers/conformance.test.ts --config .claude/skills/add-k8s-driver/conformance.vitest.ts
```

```nc:run effect:check
pnpm exec eslint src/drivers/kubernetes-driver.ts src/drivers/kubernetes-driver.test.ts
```

The second command runs the stock conformance cases against the Kubernetes harness without changing the trunk suite.
