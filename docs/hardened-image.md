# Hardened agent image (recommended for Claude)

By default `./container/build.sh` builds the agent container on your machine from a public Node
base — three to ten minutes, no account, no request to any service. **That stays the default and
stays fully supported.**

Alternatively an install can **fetch a prebuilt, hardened image** instead. It is retagged to
exactly the name the build would have written (`nanoclaw-agent-v2-<slug>:latest`), so nothing
downstream can tell the two apart: the host spawns the same tag either way, and derived per-group
builds still work offline.

**For Claude installs, we recommend the hardened image.** Local builds remain supported if you
prefer an unauthenticated build on your own machine.

That image is built by **[Echo](https://echo.ai)**, who rebuild the sandbox's contents — Chromium,
Node, Bun, pnpm, git and the rest — from scratch with only the essentials, and patch what remains.
Isolation already keeps a misbehaving agent away from your machine; this is the other half, and
the reason it exists: the software the agent *uses* is worth patching too. Chromium alone is tens
of millions of lines you did not write and do not track.

Fetching ours needs no configuration — the image reference ships in `versions.json` and the
account service is built in. Sign in and setup does the rest. It needs a free NanoClaw account;
see [With a NanoClaw account](#with-a-nanoclaw-account) for what that involves and what it
records.

It is roughly an 800 MB download, served from `us-east-1` with no CDN in front of it, so how long
it takes is mostly a question of your link to Virginia. Close by it is quick; from Europe or Asia
on a domestic connection it can take longer than simply building the image, which is CPU-bound
and parallel rather than one bandwidth-limited stream. Worth knowing before you trade an account
for it — and `./container/build.sh build` is always there.

The same path works against **any registry this machine can already `docker login` to** — a
corporate Harbor, an internal mirror you populate yourself, a vendor registry you hold
credentials for, even a `docker save`/`docker load` image. Set `NANOCLAW_HARDENED_IMAGE=true` and
`NANOCLAW_AGENT_IMAGE_REF`; authentication is then whatever docker already holds, and no account
is involved.

## What it buys

- **Patch currency in layers you did not write** — Chromium, Node, Bun, OS packages, glibc —
  rebuilt and patched on Echo's CVE cadence rather than whenever you happen to re-run a build.
  A local build gives you the standard upstream versions, which is where most container images
  start; this keeps them current without you tracking any of it.
- **A digest you chose.** Pin `repo@sha256:…` and the bytes under your local tag are those bytes
  or the pull refuses.
- **No multi-gigabyte local build** on every machine and reinstall.

## What it does not buy

**It does not contain the agent.** `/app/src` and `/app/skills` are read-only bind mounts from
your own checkout at every spawn, and the container starts with `--entrypoint bash`, bypassing
the image's entrypoint. The code your agent runs is the code in your checkout — unsigned, and
reviewed by nobody but you.

Containment is runtime configuration you own. `NANOCLAW_EGRESS_LOCKDOWN=true`, the mount
allowlist, and per-group resource limits all do more here than any image can.

## What changes

| | Pull | Build |
|---|---|---|
| `install_packages` | Works, as a derived image | Works |
| Non-Claude providers | Only if the publisher baked the CLI, or you add it | Work |
| Custom `Dockerfile` edits | Replaced on the next refresh | Yours |
| `INSTALL_CJK_FONTS` | Whatever the publisher baked — or `fonts-noto-cjk` via `install_packages` | Your choice |

Nothing rebuilds the pinned image itself: `./container/build.sh` with no argument exits `3` and
prints what to run instead, so a skill that rebuilds can't silently replace the pulled bytes.

`install_packages` is the exception, and it works because it never rebuilds the base — it builds
a small image `FROM` the one you pulled and adds your layers, then pins that group to it. The
vendor's bytes are still underneath, unmodified.

What that costs is the vendor's claim over that one group. Their scan covered the base, not
whatever you added on top, so a derived image labels itself `derived` rather than inheriting
`hardened` — `--status` will say so. A refresh clears these pins, and the group returns to the
shared image, losing the extra packages.

## Configuration

All optional, all read from `.env` or the environment.

| Variable | What it does |
|---|---|
| `NANOCLAW_HARDENED_IMAGE` | `true` makes this install pull instead of build. The sign-in sets it for you. |
| `NANOCLAW_AGENT_IMAGE_REF` | The image to pull, ideally `repo@sha256:…`. Overrides the `agent-image` pin in `versions.json`. |
| `NANOCLAW_REGISTRY_API` | Base URL of the account service. Defaults to ours; set it only to point at a different one. |
| `NANOCLAW_REGISTRY_ENROLL_CODE` | Redeem an enrolment code without a browser. For CI. |
| `NANOCLAW_REGISTRY_TOKEN` | Adopt an existing account token directly. |
| `NANOCLAW_ALLOW_UNLABELED_IMAGE` | Accept an image with no agent-runner lock label — needed for a `docker save`/`load` or third-party image. |

If you point this at your own registry you need none of these beyond
`NANOCLAW_HARDENED_IMAGE` and a reference: authentication is whatever
`docker login` already holds, and there is no account involved.

## Architecture

`amd64` and `arm64` both work. A local build always matches the machine it runs
on, so nothing to configure there.

For pulls, the reference decides. Point the pin at a **multi-arch index digest**
and docker resolves it to the running platform by itself — one pin, both
architectures, and the digest still pins content exactly:

```json
"agent-image": "repo@sha256:<index digest>"
```

A publisher that ships per-architecture references instead of one index can be
pinned per platform, keyed by docker's platform string:

```json
"agent-image": {
  "linux/amd64": "repo@sha256:…",
  "linux/arm64": "repo@sha256:…"
}
```

Either way the architecture that gets tagged is checked against the daemon's
before anything is retagged, so a single-architecture reference on the wrong
machine fails loudly instead of landing an image that only runs under emulation.

## Existing installs: switch to the hardened image

### Detect

Check what this install is configured to use and what the local image actually contains:

```bash
pnpm exec tsx setup/index.ts --step registry
```

`Image source: build here` means the install is still using the local-build path.

### Why

Echo rebuilds Chromium, Node, Bun, pnpm, git, and the base packages from scratch with only the
essentials, then patches what remains. This improves patch currency and provenance for the
sandbox components; it does not change the agent code mounted from your checkout or replace
NanoClaw's runtime isolation controls.

### Fix

For a Claude install, sign in and refresh to the pinned image:

```bash
bash setup/registry-login.sh
pnpm exec tsx setup/index.ts --step registry -- --refresh
```

Nothing re-pulls on its own — `--refresh` is how a new image reaches you.

### Verify

```bash
pnpm exec tsx setup/index.ts --step registry
```

The status should report `Image source: pull a pinned image`, `On this machine: hardened`, and
`PIN_MATCH: true`.

### Rollback

Return to the fully supported local-build path:

```bash
pnpm exec tsx setup/index.ts --step registry -- --opt-out
./container/build.sh build
```

`--status` reports what you asked for **and** what the local tag actually holds. Those can
disagree, for instance if a pull failed and a local build filled in. The image carries its own
provenance label, which a retag cannot forge, so the second answer is the trustworthy one.

A group that previously ran `install_packages` is pinned to its own derived image and would keep
spawning it. The pull path clears those pins, so such a group loses its extra packages and
returns to the shared image.

## With a NanoClaw account

The hosted registry is gated, so fetching *our* image needs a free account. This is the only
part of NanoClaw that involves an account or reports anything identifiable.

```bash
bash setup/registry-login.sh          # opens your browser
bash setup/registry-login.sh --code <code>   # or an enrolment code, e.g. for CI
```

**What is collected:** your verified email address and identity-provider user id at sign-in; a
timestamp, the image requested, and your IP truncated to a /24 at each fetch; and in the
registry's own logs, that a pull happened against an opaque random token. Your email is read
from the provider server-side, never taken from your machine, because it is the key your account
is stored under.

Sign-in also asks, once, whether you want occasional product email. It defaults to no, an
unanswered prompt is a no, and declining changes nothing about the perk — you are already signed
in by the time it appears. Saying yes stores the answer with the wording you were shown; every
email carries an unsubscribe link, which is how you change your mind today.

**What is never collected:** anything about your agents — no groups, channels, messages, prompts,
files, or API keys. Nothing calls home once the image is local; the host runs a local tag and has
no notion of a registry. We also cannot tell whether you ever *run* the image, only that you
acquired one.

The credential lives at `~/.config/nanoclaw/`, mode `0600`, and can do exactly one thing: ask for
a short-lived, pull-only credential for one repository. `--logout` revokes it server-side and
removes the docker credential helper.

Your account is keyed on your **verified email**. Signing in with a personal address and later a
work one gives you two separate accounts — deliberate, since merging on anything weaker is how
account-takeover bugs happen — and there is no way to merge them today. Pick one address.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `./container/build.sh` exits 3 | Pinned install. `pull` to refresh, `build` to force local. |
| Setup never offers the pull option | The option needs a Claude install and an `agent-image` pin in `versions.json`. Existing installs can follow [the migration above](#existing-installs-switch-to-the-hardened-image). |
| Pull fails: lockfile mismatch | The image was built against a different `container/agent-runner/bun.lock`. Refresh the pin or build locally. |
| Pull fails: architecture mismatch | The reference names one architecture and it isn't this daemon's. Use a multi-arch index, or the reference for this architecture. |
| "No agent-image reference for linux/…" | The pin is per-platform and has no entry for this machine. Build locally, or set `NANOCLAW_AGENT_IMAGE_REF`. |
| Pull fails: auth | `--status` shows whether the credential helper is wired; `--force` re-runs sign-in. |
| Signed in, but `--status` says "build here" | Re-run sign-in with `--force`. |
| Sign-in code expired | It lives 5 minutes. Run it again. |
| "No NanoClaw registry at &lt;url&gt;" | `NANOCLAW_REGISTRY_API` is unset or wrong. The default host resolves but is not a registry, so this is a configuration error, not an outage. |
