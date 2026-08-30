---
name: dev-child-sync
description: Push your working tree into a claimed nanoclaw child environment and see it live — src/ + container/ streamed over the child apiserver, rebuilt in-instance, rolled out, probed with a chat round-trip. For a dev-flavor claim (envs claim --dev <dir>) the reload arm skips the transfer entirely — the child mounts your tree, so build-here + rollout is the whole loop. Use when a change to a nanoclaw tree needs to run inside a claimed child rather than in this sandbox; for dev-flavor claims of OTHER stamps use the dev-reload skill.
---

# Syncing code into a claimed nanoclaw child

A claimed `nanoclaw`-stamp child runs the host as `deployment/nanoclaw-host`
in namespace `nanoclaw`, working out of a persistent volume at
`/nanoclaw/host`. The child holds no repo credentials, and its egress floor
admits nothing — a clone or package install started inside it has nowhere to
go. Code arrives over the one route the claim opens: the child apiserver's
exec stream, driven from here. `child-sync.ts` beside this file is that
transfer, end to end:

```bash
bun /workspace/group/.claude/skills/dev-child-sync/child-sync.ts
```

## Five stages, one exit code each

| stage | what happens | exit on failure |
|---|---|---|
| preflight | kubectl resolves on PATH, the kubeconfig opens, `deployment/nanoclaw-host` answers in ns `nanoclaw` | 2 |
| transfer | `tar cz` of `src/` + `container/` piped into `tar xz` at `/nanoclaw/host` in the host pod | 3 |
| build | `pnpm run build` inside the instance | 4 |
| reload | `rollout restart`, wait for the deployment to come back Available, and check that a different pod answers | 5 |
| probe | in-pod `pnpm run chat` round-trip; the reply prints to stdout | 6 |

Exit 0 means all five completed — the child is running your tree and
answered a message on it. A bad flag is exit 1.

## The dev-flavor hot loop: `reload`

A child claimed with `--dev <path relative to your /workspace>` (sugar for
`--options '{"dev-tree": "<path>"}'`) MOUNTS your working tree at
`/nanoclaw/host` instead of seeding a copy — the transfer stage has nothing
to transfer, and the loop collapses to build-here + rollout:

```bash
bun /workspace/group/.claude/skills/dev-child-sync/child-sync.ts reload
```

Three stages: sandbox-side `pnpm run build` in `--source` (default: cwd —
`dist/` appears inside the child through the mount), the same Recreate
rollout with the same replaced-pod check, a session-pod recycle (runner
sources load at container spawn — a session alive across the reload would
keep answering from the pre-reload tree), and the same chat probe.
Expected edit-to-live is tens of seconds instead of the full sync's
~2 minutes.

Reload preflight refuses a child that is not dev-flavor (no
`NANOCLAW_DEV_TREE=1` on the deployment): rolling a baked child just reboots
the tree it already has, which reads as an inexplicably ignored edit. It
also refuses a `--source` without `node_modules` — a dev child runs from
YOUR tree, dependencies included (the baked deps live under `/opt`, which
the dev flavor never seeds), so `pnpm install` in the workspace comes first.
The child writes its own `data/` and `groups/` into the mounted tree; keep
them out of your commits (nanoclaw's `.gitignore` already covers them).

Two scope rules stand behind the claim itself. The `dev-tree` path resolves
under your SESSION workspace only — `/workspace/agent` (the durable group
folder) is a separate mount the host cannot resolve there, so a checkout
under it must be cloned or copied directly under `/workspace` first. And one
tree carries at most one live child: a claim naming a tree that some live
dev claim already mounts is refused at claim time — two children would both
write `data/` and `groups/` into it — so release the first claim before
re-pointing the tree.

The full sync arm remains the fallback for what a mount cannot carry and
for baked children.

Three mechanical facts stand behind a green reload. The deployment's strategy
is Recreate, so the old pod is gone before the new one starts. The readiness
gate is `test -S data/ncl.sock` and the child image's entrypoint unlinks that
socket before exec — the socket lives on the PVC and a node process never
unlinks it on the way out, so without that removal a file from an earlier boot
would read as ready from t=0. Its existence therefore means this boot reached
its last step. And the sync reads the pod's identity before the restart and
again after the wait: the same pod on both sides is exit 5, not a green line.

## Flags and defaults

- `--kubeconfig <path>` — the child to sync into. Default: the minted path
  of your claimed env (read from `ncl envs list`). An exported `$KUBECONFIG`
  is never consulted — every kubectl call carries an explicit
  `--kubeconfig`, so a leftover export cannot retarget the sync. With
  several claimed envs the default is ambiguous and the run says so; the
  flag picks one. The paths `ncl envs get` prints are mounted
  read-only into this sandbox at those exact host paths — only your group's
  claimed children are there, and a released env's path is gone, which is
  what an ENOENT on it means.
- `--source <dir>` — the tree to sync. Default: the current directory. It
  must carry `src/`, `container/`, and `package.json` — the shape the
  in-instance build expects.
- `--rollout-timeout <seconds>` — the reload wait bound. Default 300.
- `--exec-timeout <seconds>` — the bound on each exec stage: the transfer
  stream, the in-instance build, the chat probe. Default 600. It catches a
  stage that has stopped making progress at all — a pod that dies mid-stream,
  an exec that never returns — rather than one that is merely slow; expiry
  reports that stage's own exit code and says it timed out. Without it a dead
  exec stream is indistinguishable from a slow one, and the wait never ends.

## What transfers and what does not

Only `src/` and `container/` stream, excluding `node_modules`, `.git`,
`data`, `groups`, `dist`, and `.env` at every depth.

- `node_modules` has nothing to do in the pipe: dependencies are baked into
  the child image, and behind the child's default-deny egress an install
  inside it has nowhere to fetch from.
- `dist` is regenerated by the in-instance build — a stale local one would
  only race the fresh one.
- `data/` and `groups/` are the instance's own state; the sync lands beside
  them without touching them. Child configuration is pod env — there is no
  `.env` in the child to replace.

Extraction overlays: a file deleted from your tree stays in the pod until
the volume is re-seeded. A fresh claim starts from the image's baked tree.

## What a failed stage leaves in the child

`/nanoclaw/host` is the live tree, not a staging area — the extract writes
into the running instance, so the stages are not all-or-nothing:

- **transfer (3)** — the tree can be part old and part new. The host reads it
  for every session pod it spawns (`container/agent-runner/src` mounts in
  read-only, skills are copied per spawn), so a cut-off extract is what the
  next session runs, not a no-op. Re-running writes every file again and
  converges the tree.
- **build (4)** — the tree is new, `dist/` is old or half-written, and the
  running pod keeps serving the build it booted with until a rollout.
- **reload (5)** and **probe (6)** — tree and build are both in place; what
  failed is the restart or the answer to a message.

The extract overwrites files in place (plain `tar -xz` — `--unlink-first`
cannot work here: GNU tar applies it to directory entries too, and a
non-empty directory cannot be unlinked, so every directory in the archive
errors). A session pod holding one of those files open through a read-only
mount can therefore observe bytes changing mid-write; sessions in a dev
child are disposable, and the host's own running code (`dist/`) is untouched
until the build-then-rollout that follows.

Two syncs into one child interleave rather than queue: the first one's
Recreate rollout takes the pod away, and the second one's exec dies mid-stage
against a pod that no longer exists, leaving a tree that is part one checkout
and part the other. Whichever sync runs afterwards to exit 0 overwrites all of
it and leaves the child on that tree.

## The client and the wire

kubectl is the workspace-installed one (`/workspace/tools/bin`, per
dev-toolchains) — neither this image nor the child image carries a kubectl.
The child API dials direct: its address is carved out of the egress proxy
via NO_PROXY, and the kubeconfig's pinned CA is one the proxy's MITM cannot
serve, so the direct dial is the only one that completes. The whole
transfer is a single exec stream through the child apiserver — a claimed
tree is a few MB of source, and that stream is the same 8443 route the
claim already opened; no other port is involved.
