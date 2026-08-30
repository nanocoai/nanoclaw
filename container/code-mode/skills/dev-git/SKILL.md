---
name: dev-git
description: Configure git for this governed sandbox before the first clone, fetch, or push. Workspace-persistent global config first, then HTTPS-only remotes and the gateway CA.
---

# Git in the governed sandbox

## First, every session: global config lives in the workspace

The pod's home directory is ephemeral — a `~/.gitconfig` is gone on the
next respawn — and once `GIT_CONFIG_GLOBAL` is exported, git never reads
`~/.gitconfig` at all. So this export comes BEFORE any `git config
--global` command, re-exported each session; a rewrite written before it
lands in the ephemeral file and silently never applies:

```bash
export GIT_CONFIG_GLOBAL=/workspace/.gitconfig
```

## HTTPS only — ssh remotes cannot work here

Not a rule — a fact of the network: the sandbox's egress floor admits only
DNS and the gateway, and ssh does not ride an HTTP proxy, so port 22 never
leaves the pod. An ssh remote just hangs. HTTPS through the gateway is the
path that exists. These rewrites make tools that default to ssh URLs work
over it — set once, they persist in the workspace across respawns:

```bash
git config --global url."https://github.com/".insteadOf git@github.com:
git config --global --add url."https://github.com/".insteadOf ssh://git@github.com/
```

Then set the proxy CA so HTTPS remotes verify through the gateway:

```bash
git config --global http.sslCAInfo /run/nanoco/proxy-ca.pem
```

## Credentials: you never hold one

There is nothing to configure: the sandbox is never given a git credential
(the driver refuses secret-shaped env, and none is mounted). Authentication
is injected at the gateway by origin match — clone over plain HTTPS and the
gateway attaches the right credential for origins the deployment has
provisioned.

Honest limitation: git's discovery endpoint (`GET .../info/refs`) is not
yet part of the governed surface, so clones and fetches may 403 even for a
provisioned origin until the governance side lands it. There is no
workaround from in here — the sandbox holds no credential to supply, and
the gateway classifies requests by operation, not by what they carry. If
you hit it, report the gap.
