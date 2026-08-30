---
name: stamp-author
description: Author an environment stamp for the project you are working on and register it so it becomes claimable via ncl envs claim. Covers the manifest shapes, the platform's clamps, and the approval flow. Use when you want a project — yours or one you are developing — to run as a claimable child environment, set a warm pool for it, or update/retire a stamp you registered.
---

# Author and register a stamp

A **stamp** is the definition `ncl envs claim --stamp <id>` realizes: what runs
inside a claimed child environment. Builtin stamps (`nanoclaw`, `sample-app`)
are code-provided; the **stamps registry** lets you register your own, so the
project you are working on becomes claimable like any other. Registration is
approval-gated — a human reviews exactly the manifest you propose.

## The two shapes

**App shape** — one image, one port; the platform renders the Deployment +
Service and gates readiness on the port answering:

```
ncl stamps create my-api --config '{"app": {"image": "ghcr.io/org/my-api:1.4", "port": 3000, "env": {"MODE": "demo"}}}'
```

**childManifests shape** — a raw manifest stream applied verbatim inside the
child cluster, for anything richer than one app. You MUST declare `readiness`:
the platform does not interpret your stream, so the named Deployment's
Available condition is the only definition of "up" it has:

```
ncl stamps create my-stack --config '{"childManifests": "<json/yaml document stream>", "readiness": {"deployment": "my-api", "namespace": "default"}}'
```

Neither field = a bare child cluster (legal, occasionally useful).

**More than one component?** `readiness` takes a LIST, and the stamp is ready
only when every named Deployment is Available:

```
"readiness": [{"deployment": "gateway", "namespace": "system"},
              {"deployment": "governance", "namespace": "system"},
              {"deployment": "nanoclaw-host", "namespace": "nanoclaw"}]
```

Name every component whose absence would make the environment a lie — the list
is what a claim WAITS for, so a leg you leave out is a leg nobody waited for.
An empty list and a repeated `{deployment, namespace}` pair are both refused.

## Passing `--config`

Pass the config as **one compact JSON string argument**, the way both examples
above show. `--stdin-json` looks like the careful choice once the config is a
multi-kilobyte manifest full of quotes and newlines — it is not. It delivers
`--config` as a parsed object, and the parser accepts only the string form. A
platform fix is in flight; until it lands, string-form is the shape that works.

Build that argument with something that hands argv over directly rather than
interpolating a manifest through a shell. And note *when* the mismatch surfaces:
the request is held, a human approves it, and only then does it fail — an
approval spent on a malformed request, not on your manifest.

## Whole-deployment stamps: per-instance identity

If your stream deploys something with an INSTALLATION IDENTITY — a gateway, a
governance, anything that scopes data by org — that identity must be the
child's own, and the platform gives you the seed:

```
{"name": "ORG_ID", "value": "org-${INSTANCE}"},
{"name": "INSTALL_ID", "value": "${INSTANCE}"}
```

Your component's own spelling works the same way — `NANOCO_GW_ORG_ID`,
`GOVERNANCE_ORG_ID`, whatever the image reads.

`${INSTANCE}` resolves at apply to the child's own namespace name — unique per
instance, and minted at POOL FILL so a warm slot's identity is the slot's, not
its claimant's. Writing those keys as literals is REFUSED at registration:
two things sharing `ORG_ID`/`INSTALL_ID` are one installation to governance and
the gateway, so a child that inherits them is a second front door onto an org
that already exists — it works, wrongly.

The refusal is a KEY SHAPE, not a list of names: anything matching
`([A-Z][A-Z0-9]*_)*(ORG|INSTALL|INSTALLATION)_ID` — `ORG_ID`, `INSTALL_ID`,
`INSTALLATION_ID`, `NANOCO_GW_ORG_ID`, `GOVERNANCE_ORG_ID`, your component's
spelling — in env entries and in ConfigMap/Secret payloads. It also refuses a
`valueFrom` or a base64 Secret entry for them, because the approver signs what
they can read. Two consequences worth knowing:

- Your stream must be a stream of JSON documents if it names an identity key at
  all (JSON is valid YAML, so `kubectl apply` does not care). A YAML mapping is
  refused, saying so — the check has to be mechanical.
- It over-matches on purpose. A FOREIGN org id (a directory provider's, say)
  under an identity-shaped name is refused too; carry it under a name that is
  not identity-shaped.

What it does NOT do: it covers identity NAMES, never identity MATERIAL. Nothing
mints or checks your child's CA bundle, `master.key`, or service-account signing
key — if your stream mounts the parent's, it passes this check and your child is
not actually a separate installation. Identity passed as a command ARGUMENT is
not seen either. Both are on you.

## Node-imported images: say what the node must already hold

A `childManifests` stamp takes no registry origin, so every image in it is one
an operator imported. Declare them and the platform stops guessing:

```
"nodeImages": ["nanoclaw-child-host:v06", "nanoco-gateway:v12", "governance:v9"]
```

A claim of a stamp whose declared images are not all in the node's store is
refused BY NAME in seconds, and the stamp is left out of pool filling — instead
of a ten-minute boot budget spent on `ImagePullBackOff` and a generic timeout.
`ncl stamps list` shows the standing verdict per row: in-the-store,
`MISSING <n> of <m>` naming which, or `UNCHECKED` when this deployment's driver
cannot read the node's store at all (then the declaration gates nothing).

Two honesty limits: absence is only believed from a report that was read,
non-empty, and under kubelet's 50-image cap — on a busy node an absence cannot
be proven and answers "present"; and a node-imported image has no registry
digest, so a tag proves presence, never identity.

## Where the image comes from — the pull path

If your project's CI already publishes an image (it usually does), name it
FULLY QUALIFIED — an explicit registry host — and the platform does the rest:

```
ncl stamps create my-api --config '{"app": {"image": "ghcr.io/org/my-api:1.4", "port": 3000}}'
```

- **Resolution pins your tag to a digest at the approved write.** The stamp
  records `<ref>@<digest>` — the approver signs bits, not a tag that can
  move. If you pin a digest yourself it is verified instead of re-resolved.
- **Placement, not you, puts the image on the node.** After approval,
  `ncl stamps get my-api` walks `pending → pulling since <t> → placed`. No
  operator hands, no import to ask for.
- **Claims open at `placed`.** A claim before that is refused in seconds with
  the placement state — never a boot timeout. You are notified in-session
  when placement settles, same as claim readiness.
- **Private registry?** Add `"imageCredential": "<NAME>"` — a credential
  NAME the install's custody holds (the operator provisions
  `REGISTRY_<NAME>_*`); you never see or pass a value.
- **Unqualified refs are refused** (`org/app` normalizes to docker.io — a
  registerable name someone else can own). Name the host.
- A failed placement records the registry's own error on the row;
  `ncl stamps place my-api` retries the approved pull — no new approval, the
  signed digest never changes. A DELETED upstream image cannot be retried
  into existence: that needs `stamps update` with a new ref and a new
  approval, and the row's error says so.

**The opt-out** — a genuinely node-imported image (air-gapped installs,
operator-managed imports) declares it:

```
"app": {"image": "my-api:dev", "presence": "node-local", "port": 3000}
```

Only here does the old rule survive: the image must already exist on the
node, and if it does not, the claim dies as a boot timeout — ask the
operator to import it first. Choose this only when there is no registry to
pull from.

A repo with only a Dockerfile and no published image is the BUILD origin —
not realized yet; `create` refuses it with the exact message. Publish the
image and register the ref.

## The clamps — write manifests that pass

The approver reviews your manifest; the platform enforces these regardless,
so author within them rather than discovering refusals:

- **Registry images are digest-pinned and placed before claims open** (the
  pull path above); `presence: 'node-local'` images must already exist on
  the node (`IfNotPresent`, no registry pull at claim — ever).
- **PodSecurity `baseline`**: no privileged, no hostPath, no hostNetwork.
- **Resource limits**: the child's LimitRange default applies unless your
  manifests declare resources — declare them for anything bigger than a toy.
- **Ids are k8s-label-legal**, and an app-shape id also names objects
  (lowercase alphanumeric and `-`).
- Structural rules are checked at `create` — a `childManifests` stamp without
  `readiness` (or the reverse), an unqualified registry ref, or a credential
  on a node-local image is refused immediately with the exact reason.

## The dev block — opt in to the working-tree hot loop

Declaring `dev` makes your stamp claimable with `ncl envs claim --stamp <id>
--dev <path relative to your /workspace>`: the child runs FROM that working
tree instead of the baked artifact, and an edit goes live through the
declared reload arm (the `dev-reload` skill drives it) — no re-registration,
no second approval. Without the block, `--dev` refuses at claim.

**App shape** — declare where the tree mounts and what changes when it does;
the platform renders the rest:

```
"dev": {"mountPath": "/app", "command": ["bun", "--watch", "serve.ts"], "reload": {"kind": "none"}}
```

`image`/`command`/`env` override the baked ones where declared. A dev image
is node-local like every other (never a pull at claim). You never write the
securityContext: the platform renders the pod as the OWNER of the mounted
tree, stat'd at claim — that is a clamp, not a convention.

**childManifests shape** — you supply the dev variant stream:

```
"dev": {"manifests": "<json document stream>", "reload": {"kind": "rollout"}}
```

**More than one readiness gate?** Say which one mounts the tree:

```
"dev": {"manifests": "<json document stream>",
        "consumer": {"deployment": "nanoclaw-host", "namespace": "nanoclaw"},
        "reload": {"kind": "rollout"}}
```

One tree has one consumer, and the platform must not GUESS which of your gates
it is — the fidelity gate reads its evidence off the CONSUMING Deployment, so a
guess would report a dev claim ready over a tree nothing mounted. Past one gate
`consumer` is required, and it must name a pair your `readiness` list already
gates on. With one gate it is optional: that gate IS the consumer.

Rules the registration enforces (refusals at `create`, in front of the
approver):

- Your stream only MOUNTS the tree — a volume claiming the PVC named
  `dev-tree`. The platform authors that claim itself (reserved storage
  class included); a stream declaring its own `dev-tree` PVC, or naming the
  class `nanoclaw-dev-static` anywhere, is refused.
- Every pod template that mounts `dev-tree` carries the identity tokens
  VERBATIM — `"runAsUser": "${DEV_TREE_UID}"`, `"runAsGroup":
  "${DEV_TREE_GID}"` in its pod-level securityContext — declares no
  `fsGroup`, and no container-level runAsUser/runAsGroup. The platform
  substitutes the stat'd tree owner at claim; anything else would write
  wrong-owned files into the claimant's workspace or chgrp their tree.
- The stream must be JSON documents (JSON is YAML) so that clamp is
  mechanically checkable, and at least one template must mount `dev-tree`.
- Readiness stays YOUR declaration — both flavors gate on the same
  Deployment, and the platform's fidelity gate fails a claim loudly if the
  realized child is not the flavor it named.

`reload` is `{"kind": "rollout"}` (default — restart the consumer, wait
ready), `{"kind": "exec", "command": [...]}` (a process signal exec'd in the
consuming pod), or `{"kind": "none"}` (self-watching process). What the tree
must contain to be runnable (installed dependencies, a build) is your
stamp's business — say so in `--source` provenance and authoring notes.

## Place the image before you claim

The clamp above says the image must be on the node. The sequencing is the part
that bites, so run it in this order:

- **Ask the operator for the exact `name:tag` before you write the manifest.**
  Not a plausible-looking `my-api:latest` — the imported name, as containerd
  resolves it. The image field is the one thing in the manifest you cannot
  derive from the repo, so it is worth blocking on rather than guessing.
- **Confirm placement after approval and before the first claim.** Approval
  says a human liked your manifest. It says nothing about what is on the node,
  and the two can drift by hours.
- **Confirm by running the image, not by asking twice** — a throwaway pod with
  `imagePullPolicy: IfNotPresent`, then read the events. `already present on
  machine` is the answer you want; a `Pulling` line means it was never placed
  and your claim would have been racing a download.

A claim that loses that race does not tell you the image was missing. It boots
into ImagePullBackOff and dies as a **boot timeout** — the same symptom a
readiness probe that never passes produces, which is what makes the two
expensive to tell apart after the fact.

## Provenance

Pass `--source` so the registration says what it was authored against — this
is what the approver and future readers see:

```
--source '{"repo": "github.com/org/my-api", "revision": "abc1234"}'
```

Claims record the stamp version that realized them (`envs list` shows
`stamp=my-api@v2`), so an updated definition never silently rewrites what an
existing environment is.

## Lifecycle

- `ncl stamps list` — registered + builtin ids; rows excluded as invalid are
  named, never hidden.
- `ncl stamps get <id>` — definition, the pool in both halves (the size you
  asked for beside the slots the driver holds: `pool=1 (warm 1)`, and
  `— 2 dead fills, last 20s ago` when the fills are dying), plus image
  placement: origin, state with its age, and provenance
  (`pulled from <ref>@<digest>`) once placed.
- `ncl stamps update <id> --config '<json>'` — a new approved definition;
  version increments; existing envs are untouched. A registry-origin stamp
  is unclaimable at the new version until its new image places.
- `ncl stamps place <id>` — re-queue a failed placement (re-runs the
  approved pull; no new approval).
- `ncl stamps set-pool <id> --size 1` — warm slots; takes effect within about
  a minute of approval. Watch it land on `stamps get`: `pool=1 (warm 0)` →
  `(warm 0, filling 1)` → `(warm 1)`. Never claim an env to find out — a
  release schedules a refill that can collide with your next mutation.
  A CUT converges the same way: the slots past the new size read as
  `draining` from the moment the mutation lands, and the next reconcile
  reaps them.
  `— n dead fills, last <age> ago` is history, not a live count: nothing
  reaps a pool corpse, so it never clears on its own and the AGE is the
  signal. Seconds or minutes old means fills are DYING, not booting slowly —
  stop waiting and fix the stamp (check the image is on the node, then
  `stamps place <id>`). Hours old beside a warm slot is a pool that already
  recovered.
  `pool=1 (slots unreadable)` is the runtime not answering — the count, not
  the pool, is what failed there.
- `ncl stamps retire <id>` — new claims refuse it, the pool drains
  (`pool=0 (warm 0, draining 1)` until the reconciler reaps the slot), live
  envs keep running. Any port those envs EXPOSE is revoked, though: an
  exposure is approved against a named definition, so withdrawing the
  definition withdraws the approval's subject. The envs themselves are
  untouched — only their reachability from outside the cluster ends.

## The approval flow

Every mutation from a sandbox is held for admin approval — you will get
"Approval request sent to admin". The command runs automatically when
approved; you are notified either way. Write the `--source` provenance and
keep the manifest minimal: the approver is reading exactly what you send.
