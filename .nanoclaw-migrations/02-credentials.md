# 02 — Credentials (OneCLI Agent Vault)

> ✅ **VERIFIED** against `origin/main:.claude/skills/init-onecli/SKILL.md` and `origin/main:CLAUDE.md` on 2026-05-27.

User direction 2026-05-27: «Я хочу использовать нативные нативные решения из V2. Давай использовать то, что рекомендуется в новом решении.»

v2's recommended path **is OneCLI**:
- `origin/main:CLAUDE.md:67` — container-runner uses OneCLI `ensureAgent`
- `origin/main:src/onecli-approvals.ts` — credentialed-action approval bridge built around OneCLI
- `origin/main:.claude/skills/init-onecli/SKILL.md` — first-class onboarding skill that installs OneCLI + migrates `.env` to vault

The v2 default is OneCLI. `/use-native-credential-proxy` is the alternate path for users who don't want it. We go with the default.

## Decision

Apply `/init-onecli`. It installs OneCLI's gateway + CLI, configures the local instance, sets `ONECLI_URL` in `.env`, and migrates the OAuth token from `.env` into the vault.

## How `/init-onecli` interacts with our setup

The NixOS module on the production server already drops the Anthropic OAuth token (from sops) into `.env` via `ExecStartPre`. So when we run `/init-onecli`:

1. It detects the token in `.env`
2. Installs OneCLI gateway (`curl -fsSL onecli.sh/install | sh`) + CLI (`onecli.sh/cli/install`)
3. Configures `onecli config set api-host ${ONECLI_URL}`
4. Writes `ONECLI_URL` to `.env`
5. Waits up to 15s for gateway health (`curl -sf ${ONECLI_URL}/health`)
6. Migrates the `.env` OAuth token into vault as an Anthropic secret
7. Subsequent runs use the vault; the `.env` token can stay (defensive) or be stripped

## How to apply (Stage 1.2)

1. Activate skill: `/init-onecli`
2. Skill walks through preflight, install, configure, migrate, verify
3. After success: `onecli secrets list` should show the Anthropic secret

## NixOS module impact (Stage 5, separate repo)

When updating the NixOS module in `~/Documents/GitHub/nixserver/`:
- `ExecStartPre` still drops sops token into `.env` (unchanged) — `/init-onecli` ingests on first run
- New: ensure `${ONECLI_URL}` resolves correctly inside the NixOS systemd unit (default is local — the install script outputs the URL)
- New: include `onecli` binary in PATH for the service user (install script puts it in `~/.local/bin`)
- Lock the gateway socket/port to localhost (default behavior — verify)

These are deploy-infra concerns, out of scope for this repo but flagged for Stage 5.

## What we drop from v1

- `src/credential-proxy.ts` and its test — gone (`main` already doesn't have them)
- `CREDENTIAL_PROXY_PORT` config — gone
- The `package.json` carrying `@onecli-sh/sdk` was already there (v1 left it as dead dep) — in v2 it's a live dep again, no action needed
- Whole approach of "we don't want OneCLI" — that was my mis-projection, dropped
