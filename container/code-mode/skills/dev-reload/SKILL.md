---
name: dev-reload
description: Make an edit live in a dev-flavor claimed environment of ANY stamp that declares a dev block — read the stamp's declared reload kind from ncl stamps get, verify the running child really is the dev flavor, and drive the reload over the claimed kubeconfig. Use after editing the working tree behind an `envs claim --dev` environment, whatever project the stamp runs. For nanoclaw-stamp children prefer dev-child-sync, which adds the session-pod recycle and chat probe on top of this floor.
---

# Reload a dev-flavor claim — any stamp

A child claimed with `--dev <path>` runs the stamp's DEV VARIANT: the working
tree you named mounts inside the consuming workload, so your edits are already
THERE — what remains is making the running process serve them. How that
happens is the stamp's own declaration: `dev.reload` in its registered config.
This skill is the generic floor; a stamp may ship richer guidance of its own
(nanoclaw ships `dev-child-sync`).

Reload-complete is always the same thing: the stamp's own readiness going
green again.

## 1. Read the declaration

```bash
ncl stamps get <stamp-id>
```

The `dev:` line names the reload kind. The CONSUMING workload — the
deployment your reload targets — is the stamp-id-named Deployment in
namespace `default` for an app-shape stamp, or the `readiness:` deployment
for a childManifests stamp. Builtin stamps are not registry rows; for
`nanoclaw` the consumer is `nanoclaw/nanoclaw-host` and the kind is
`rollout` (use `dev-child-sync`).

Every kubectl call below carries the claimed env's minted kubeconfig
(`ncl envs get <env-id>` prints the path; it is mounted read-only into this
sandbox at that exact path):

```bash
KC=--kubeconfig=<path from envs get>
```

## 2. Preflight: is this child actually the dev flavor?

Rolling a baked child just reboots the tree it already has — an edit that
reads as inexplicably ignored. The dev flavor is observable as cluster
state, the same predicate the platform's fidelity gate asserts host-side:
the consuming Deployment's pod template mounts a PVC named `dev-tree`.

```bash
kubectl $KC get deployment <consumer> -n <consumer-ns> \
  -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim.claimName=="dev-tree")].name}'
```

Empty output = not a dev-flavor child; stop and claim with `--dev`.

## 3. Drive the declared kind

- **`rollout`** (the default) — restart the consumer and wait for its own
  readiness to come back:

  ```bash
  kubectl $KC -n <consumer-ns> get pods -o name          # note the pod
  kubectl $KC -n <consumer-ns> rollout restart deployment/<consumer>
  kubectl $KC -n <consumer-ns> rollout status deployment/<consumer> --timeout=300s
  kubectl $KC -n <consumer-ns> get pods -o name          # a DIFFERENT pod must answer
  ```

  The replaced-pod check is not optional: the same pod on both sides means
  nothing restarted, however green the status line reads.

- **`exec`** — the declared process signal, exec'd in the consuming pod
  (config-heavy services that reload on HUP, touch-file watchers):

  ```bash
  kubectl $KC -n <consumer-ns> exec deploy/<consumer> -- <declared command>
  ```

  The command is part of the approved stamp config — run it verbatim from
  `stamps get`, then re-check the consumer's readiness.

- **`none`** — a self-watching process (`bun --watch` and kin): saving the
  edit was the reload. Verify by observing the change, not by restarting.

## 4. What the platform guarantees underneath

- The mount is your session workspace's tree, read-write; whatever the child
  writes into it is yours and survives the env (it lives on your session
  volume). One tree carries at most one live child — a second `--dev` claim
  naming the same tree is refused at claim.
- The child runs as the tree's OWNER (the platform stats it at render);
  nothing in the child writes root-owned files into your workspace.
- What the tree must CONTAIN (dependencies installed, a build present) is
  the stamp's business — check its `--source` provenance and authoring
  notes; the child failing honestly is the enforcement.
