---
name: add-paws4claws
description: Install PAWS (paws4claws) as an AWS credential proxy for agent containers — replaces the awscli apt package with a lightweight wrapper that forwards aws calls to a credential daemon, keeping credentials out of containers entirely.
---

# Add PAWS AWS Credential Proxy

[paws4claws](https://github.com/seefood/paws4claws) runs AWS credentials in a dedicated daemon container. Agent containers get a drop-in `aws` wrapper that proxies calls over HTTP — no credentials, no `.aws` mount, no AWS SDK inside containers.

> **Agent usage** — optional. The wrapper is installed as `aws` on `PATH` so agents
> need no PAWS-specific instructions. For in-context guidance (file I/O patterns,
> piping large output, `paws:` errors), install the agent skill from GitHub — see
> [§10](#10-agent-skill-optional). This skill is **operator setup only**.

## How it works

```
agent container ──aws cmd──► wrapper (~/bin/aws, or mounted path — see §6)
                                  │  HTTP POST /invoke  (PAWS_TOKEN auth)
                             paws daemon (holds ~/.aws creds)
                                  │
                             real aws-cli ──► AWS API
```

The `aws` command behaves identically to the real CLI — same flags, same exit codes, same stdout/stderr. Agents don't know or care that they're using a proxy.

## Prerequisites

- Docker
- `openssl` for token generation
- `wget` or `curl` on the host (to fetch wrapper files)
- Agent containers need **`curl`** and **`jq`** (no `awscli`, no git clone)

## Source URLs

Pin a release tag once. Use the same tag for the daemon image and wrapper files so versions stay aligned.

```bash
export PAWS_TAG=v0.4.0
export PAWS_RAW="https://raw.githubusercontent.com/seefood/paws4claws/${PAWS_TAG}"
export PAWS_IMAGE="ghcr.io/seefood/paws4claws:${PAWS_TAG#v}"
```

| Artifact               | Location                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Daemon image           | `${PAWS_IMAGE}` (also `:latest` on GHCR after a release)                                           |
| Wrapper `aws`          | `${PAWS_RAW}/wrapper/aws`                                                                          |
| Wrapper allowlist      | `${PAWS_RAW}/wrapper/file_allowlist.sh`                                                            |
| Agent skill (optional) | `${PAWS_RAW}/examples/nanoclaw/use-paws/SKILL.md`                                                  |
| Operator skill (this)  | `https://github.com/seefood/paws4claws/blob/${PAWS_TAG}/examples/nanoclaw/add-paws4claws/SKILL.md` |

No git clone required. If you already have the repo, you may set `PAWS_REPO=~/paws` and use `cp` instead of `wget` — same paths under `wrapper/`.

## 1. Pull the paws daemon image

```bash
docker pull "${PAWS_IMAGE}"
```

Verify:

```bash
docker run --rm --entrypoint aws "${PAWS_IMAGE}" --version
# aws-cli/2.x.x ...
```

## 2. Create the Docker network

Both the daemon and agent containers must share `paws-net`:

```bash
docker network create paws-net
```

## 3. Generate a bearer token

One token covers all nanoclaw agent containers (or generate one per agent group for finer control):

```bash
openssl rand -hex 32
```

## 4. Configure both `.env` files

Create a small config directory on the host (no repo clone — only `.env`):

```bash
mkdir -p ~/paws
```

**`~/paws/.env`** — daemon config. The daemon reads credentials from `~/.aws` (mounted read-only) and accepts calls bearing this token:

```bash
AWS_DEFAULT_REGION=us-east-1
PAWS_TOKEN_NANOCLAW=<token-from-step-3>
```

Add `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` here instead of the mount if you prefer env-based credentials. For EC2 instance profiles, neither is needed.

**`~/nanoclaw/.env`** — nanoclaw config. This token is injected into agent containers at spawn time:

```bash
PAWS_TOKEN=<same-token-as-above>
```

## 5. Run the paws daemon

```bash
docker run -d \
  --name paws \
  --restart unless-stopped \
  --network paws-net \
  -v ~/.aws:/root/.aws:ro \
  --env-file ~/paws/.env \
  "${PAWS_IMAGE}"
```

Check it started:

```bash
docker logs paws
# paws: listening on 0.0.0.0:7142
```

## 6. Choose a wrapper install mode

The PAWS wrapper is **two files** (`wrapper/aws` and `wrapper/file_allowlist.sh`). Fetch them from `${PAWS_RAW}` (see [Source URLs](#source-urls)). Pick **one** mode below.

| Mode                | Where files live                             | Rebuild image?      | Upgrade wrapper                            |
| ------------------- | -------------------------------------------- | ------------------- | ------------------------------------------ |
| **C (recommended)** | Host `~/bin`, mounted R/W into the container | No                  | Re-`wget` on host; no container restart    |
| **B**               | Host dir, bind-mounted read-only at spawn    | No (respawn agents) | Re-`wget` on host; new containers pick up  |
| **A**               | Baked into the agent image (`COPY`)          | Yes                 | Re-`wget` into `container/`, rebuild image |

The wrapper finds `file_allowlist.sh` next to the `aws` script (`dirname "$0"`), or at `/usr/local/lib/paws/file_allowlist.sh` (mode A layout).

### Mode C — Host `~/bin` (recommended)

**Best for:** simplest install and fastest upgrades. Nanoclaw typically mounts the agent homedir from the host; `~/bin` inside the container is a host directory you can edit without rebuilding or restarting.

1. Ensure the agent image has **`curl`** and **`jq`** (no `awscli`, no wrapper `COPY`).
1. Download both wrapper files into the agent's **host** `bin` directory (same folder — the path that appears as `~/bin` inside the container):

```bash
AGENT_BIN=~/nanoclaw/data/agents/main/bin   # adjust to your homedir layout
mkdir -p "$AGENT_BIN"
wget -q "${PAWS_RAW}/wrapper/aws" -O "$AGENT_BIN/aws"
wget -q "${PAWS_RAW}/wrapper/file_allowlist.sh" -O "$AGENT_BIN/file_allowlist.sh"
chmod +x "$AGENT_BIN/aws"
```

1. Confirm `~/bin` is on `PATH` inside the container (nanoclaw default for many setups).

No `container-runner` volume mounts or Dockerfile `COPY` lines are required for the wrapper.

### Mode B — Runtime read-only bind mount

**Best for:** one canonical wrapper directory on the host, shared across agents, without baking into the image.

1. Install files on the host (both in the same directory):

```bash
mkdir -p ~/paws/wrapper
wget -q "${PAWS_RAW}/wrapper/aws" -O ~/paws/wrapper/aws
wget -q "${PAWS_RAW}/wrapper/file_allowlist.sh" -O ~/paws/wrapper/file_allowlist.sh
chmod +x ~/paws/wrapper/aws
```

1. In **`src/container-runner.ts`**, when `PAWS_TOKEN` is set, add bind mounts to each `docker run` (paths must match inside the container):

```typescript
// Option 1 — standard layout (matches mode A paths):
'-v', `${process.env.HOME}/paws/wrapper/aws:/usr/local/bin/aws:ro`,
'-v', `${process.env.HOME}/paws/wrapper/file_allowlist.sh:/usr/local/lib/paws/file_allowlist.sh:ro`,

// Option 2 — single directory + PATH (both files colocated):
'-v', `${process.env.HOME}/paws/wrapper:/opt/paws:ro`,
// and inject: -e PATH=/opt/paws:${existingPath}
```

1. Recompile host TS (`pnpm run build`). **Respawn** agent containers after upgrading wrapper files on the host (no full image rebuild).

### Mode A — Bake into the agent image (Dockerfile)

**Best for:** operators who want the wrapper fixed inside the image. **Slowest** install and upgrade (rebuild + restart every time).

1. Download into nanoclaw `container/`:

```bash
wget -q "${PAWS_RAW}/wrapper/aws" -O ~/nanoclaw/container/aws
wget -q "${PAWS_RAW}/wrapper/file_allowlist.sh" -O ~/nanoclaw/container/file_allowlist.sh
chmod +x ~/nanoclaw/container/aws
```

1. In **`container/Dockerfile`** (ester2 branch may already have this):

```dockerfile
RUN apt-get install -y --no-install-recommends jq curl   # no awscli
COPY --chmod=755 file_allowlist.sh /usr/local/lib/paws/file_allowlist.sh
COPY --chmod=755 aws /usr/local/bin/aws
```

1. Rebuild the agent image (see §8).

## 7. Nanoclaw changes (all modes)

These apply regardless of wrapper install mode. On the `ester2` branch many are already applied.

### `src/container-runner.ts`

- Removed the `~/.aws` host mount block
- When `PAWS_TOKEN` is set in `~/nanoclaw/.env`: add `--network paws-net` and `-e PAWS_TOKEN=…` to agent `docker run`
- Add **`paws`** to `NO_PROXY` / `no_proxy` alongside `.amazonaws.com` — the OneCLI gateway sets `HTTP_PROXY`, which otherwise intercepts `http://paws:7142`

### Mode-specific extras

| Mode | Dockerfile wrapper `COPY` | container-runner bind mounts |
| ---- | ------------------------- | ---------------------------- |
| C    | None                      | None                         |
| B    | None                      | Yes (§6 mode B)              |
| A    | Yes (§6 mode A)           | Optional                     |

## 8. Rebuild and restart

| Mode  | When you need a rebuild / restart                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| **C** | Only when changing agent image deps (`jq`, `curl`) or `container-runner.ts` — **not** for wrapper-only upgrades |
| **B** | After `container-runner.ts` mount changes: `pnpm run build` + respawn agents                                    |
| **A** | After any Dockerfile or wrapper change: `cd container && ./build.sh` + restart nanoclaw                         |

```bash
pnpm run build            # compile host TS (modes B, A, or runner changes)
cd container && ./build.sh && cd ..   # mode A only (image rebuild)
systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"
```

## 9. Verify

Use the same **PATH and volume mounts** as production. Replace `nanoclaw-agent-v2-58d885a2:latest` with your image tag.

**Version check** (no `PAWS_TOKEN`, no AWS call):

```bash
docker run --rm \
  --network paws-net \
  -e "NO_PROXY=paws,.amazonaws.com,169.254.169.254" \
  -e "no_proxy=paws,.amazonaws.com,169.254.169.254" \
  nanoclaw-agent-v2-58d885a2:latest \
  aws --paws-version
# Expected (versions aligned after upgrade):
#   wrapper: 0.4.0
#   daemon:  0.4.0
# Exit 1 + stderr if wrapper and daemon differ (version drift).
```

For **mode B**, add the same `-v` / `-e PATH=…` flags you use in `container-runner.ts`. For **mode C**, run verify from a **running** agent container (host `~/bin` is mounted there):

```bash
docker exec <container-name> aws --paws-version
```

**Smoke test** (`PAWS_TOKEN` required):

```bash
source <(grep '^PAWS_TOKEN=' ~/nanoclaw/.env | tail -1)
docker run --rm \
  --network paws-net \
  -e "PAWS_TOKEN=$PAWS_TOKEN" \
  -e "NO_PROXY=paws,.amazonaws.com,169.254.169.254" \
  -e "no_proxy=paws,.amazonaws.com,169.254.169.254" \
  nanoclaw-agent-v2-58d885a2:latest \
  aws sts get-caller-identity
```

Or from a running agent: `docker exec <container-name> aws sts get-caller-identity`

## 10. Agent skill (optional)

PAWS is designed to be **transparent**: the proxy is the `aws` command on `PATH`, with the
same flags, exit codes, and stdout/stderr as the real CLI. Agents that already know `aws`
do not need any extra skill or documentation to use PAWS.

**Optional:** install the in-agent skill into your claw's agent skills directory (not next to
this operator skill — they live in different places):

```bash
AGENT_SKILLS=~/nanoclaw/data/agents/main/skills   # adjust to your layout
mkdir -p "$AGENT_SKILLS/use-paws"
wget -q "${PAWS_RAW}/examples/nanoclaw/use-paws/SKILL.md" -O "$AGENT_SKILLS/use-paws/SKILL.md"
```

Browser link (same file): `${PAWS_RAW}/examples/nanoclaw/use-paws/SKILL.md`

That skill documents runtime patterns that are easy to get wrong without reading the repo:

- piping or filtering large AWS output before it hits context
- v0.3 upload paths (`./file` vs `file://`) and v0.4 local download destinations
- interpreting `paws:` proxy errors vs ordinary AWS failures

Skip this step if you prefer agents to discover `aws` on their own; nothing in nanoclaw or
the wrapper requires the skill to be present.

## 11. Upgrading PAWS

1. Set `PAWS_TAG` to the new release (e.g. `v0.5.0`) and refresh [Source URLs](#source-urls).
1. Pull the new daemon image and restart the `paws` container:

```bash
docker pull "${PAWS_IMAGE}"
docker stop paws && docker rm paws
# re-run §5 docker run with the new image
```

1. Re-fetch the wrapper per mode:

| Mode  | Wrapper upgrade steps                                                                           |
| ----- | ----------------------------------------------------------------------------------------------- |
| **C** | Re-run the `wget` lines from §6 mode C into host `~/bin` — **no container restart**             |
| **B** | Re-run the `wget` lines from §6 mode B into `~/paws/wrapper/` — respawn agent containers        |
| **A** | Re-run the `wget` lines from §6 mode A into `container/`, rebuild agent image, restart nanoclaw |

1. Optional: re-`wget` the agent skill (`§10`).
1. Run `aws --paws-version` to confirm wrapper and daemon match.

## File I/O limitations

| Blocked / not yet              | Use instead                                      |
| ------------------------------ | ------------------------------------------------ |
| `aws s3 cp s3://… /local/path` | supported via v0.4 `outputFiles`                 |
| `aws s3 cp --recursive …`      | not supported (v0.5)                             |
| `aws s3 cp /local/path s3://…` | `aws s3 cp ./local s3://…` (v0.3) or pipe to `-` |
| `aws s3 sync ./local s3://…`   | not available (v0.5 planned)                     |
| `aws s3 cp s3://src s3://dst`  | server-side copy                                 |

## Troubleshooting

### `paws: daemon unreachable`

1. Both containers on `paws-net`? `docker network inspect paws-net`
1. Daemon running? `docker ps | grep paws`, `docker logs paws`
1. **`HTTP_PROXY` intercepting?** — the OneCLI gateway sets `HTTP_PROXY` inside containers. If `NO_PROXY` doesn't include `paws`, every curl to `http://paws:7142` is routed through the OneCLI proxy which rejects it. Confirm `NO_PROXY` contains `paws`:
   ```bash
   docker exec <agent-container> bash -c 'echo $NO_PROXY'
   # should include: paws,...
   ```
   If missing, the `container-runner.ts` change wasn't compiled (`pnpm run build` was skipped).

### `unauthorized` on stderr

The `PAWS_TOKEN` in the agent container doesn't match any `PAWS_TOKEN_*` in the daemon. Re-check both `.env` files have the same hex value.

### `aws` command not found

| Mode  | Check                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| **C** | Both files on the **host** `bin` path that mounts as `~/bin`; `which aws` inside the container shows `~/bin/aws` |
| **B** | Bind mounts present on `docker inspect <container>`; host files exist under `~/paws/wrapper/`                    |
| **A** | `container/aws` and `container/file_allowlist.sh` present; Dockerfile `COPY` lines present; image rebuilt        |

### `paws: file_allowlist.sh not found`

The wrapper could not find its allowlist. **Mode C / B (colocated):** `file_allowlist.sh` must sit in the **same directory** as the `aws` script. **Mode A:** confirm `/usr/local/lib/paws/file_allowlist.sh` exists in the image.

### Daemon not persisting across reboots

The container has `--restart unless-stopped` which survives crashes and reboots as long as Docker starts on boot. Verify: `systemctl is-enabled docker`. If Docker isn't enabled, either enable it or create a systemd unit for the paws container.
