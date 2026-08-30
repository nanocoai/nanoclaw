---
name: dev-toolchains
description: Install project toolchains (compilers, runtimes, kubectl, linters) into the workspace. Use before building or testing any project whose tools are not already under /workspace/tools — never rely on whatever version the image happens to carry.
---

# Toolchains live in the workspace, not the image

The image is disposable and generic; `/workspace` is durable and yours (D22).
Install the PROJECT's toolchain versions into the workspace and never depend
on an image-provided compiler, runtime, or CLI being present or being the
right version.

## Check before install — every boot repeats

Every lease expiry is a fresh boot over the SAME workspace. Your install
steps will run again on top of their own previous results, so make them
idempotent: check first, install only what is missing.

```bash
export PATH="/workspace/tools/bin:$PATH"   # put this first, every session
command -v kubectl >/dev/null || <install it>
```

## Convention

- Install into `/workspace/tools`, binaries (or symlinks to them) in
  `/workspace/tools/bin`.
- Export `PATH="/workspace/tools/bin:$PATH"` at the start of each session;
  the pod's shell profile does not survive a respawn, so re-export rather
  than persisting it image-side.
- `kubectl` is not in the image on purpose — install the version matching
  your claimed cluster into `/workspace/tools/bin`.

## Downloads go through the proxy

All egress rides the governed proxy. The environment is already set up:
`HTTP_PROXY`/`HTTPS_PROXY` carry the proxy URL, and the CA bundle at
`/run/nanoco/proxy-ca.pem` is exported as `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, and `REQUESTS_CA_BUNDLE`. Use installers
that honor those variables (curl, wget, npm, pip, go all do). Do not unset
them, and do not use tools that pin their own CA store without a flag to
point at the bundle.

## A 403 is policy, not a bug

Download origins are governed: the deployment allows a specific set of
hosts. If an origin returns 403 through the proxy, that is deployment
policy — report the origin you need so it can be requested, and say so
plainly in your channel. Do not search for mirrors or tunnels to work
around it.
