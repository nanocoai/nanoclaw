---
name: use-native-credential-proxy
description: Opt out of the OneCLI gateway and supply Anthropic credentials from .env instead. For users who want simple .env-based credential management without the OneCLI agent vault. Reads the API key or OAuth token from .env and injects it into the container's API requests.
---

# Use Native Credential Proxy

This skill adds a **native, `.env`-based credential path** for the container agent — an explicit opt-out of the OneCLI gateway. With it enabled, NanoClaw reads the Anthropic credential straight from `.env` and threads it into the container as standard environment variables, which the Claude Agent SDK reads natively. No OneCLI vault, no HTTPS proxy, no certificates.

> **Credential-home inversion — read this first.** NanoClaw's default is that credentials live in the OneCLI agent vault and are injected per request, never threaded into the container via `-e`. This skill deliberately inverts that: the credential lives in `.env` on the host and is passed into the container's environment. That inversion is the *entire point* of this skill (simple `.env` credentials without OneCLI). Use it only if you accept that tradeoff; everywhere else in NanoClaw, env-threaded credentials are an anti-pattern.

The skill is **additive**: it ships its proxy logic and tests in this folder, copies them into `src/`, and makes two small edits at the container-spawn seam (both gated by an env flag) — one to thread the `.env` credential into the container, one to skip the OneCLI gateway. When the flag is unset both are no-ops and the gateway path is exactly as it was; when it is set, the gateway is bypassed and the credential comes straight from `.env`.

## How it works

- `src/native-credential-proxy.ts` exports `nativeCredentialEnvArgs()`. It reads `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` (and optional `ANTHROPIC_BASE_URL`) from `.env` via core's `readEnvFile`, and returns the Docker `-e VAR=value` arguments.
- Most gating lives inside `nativeCredentialEnvArgs()`: it returns an empty array unless `NANOCLAW_NATIVE_CREDENTIALS=true`, so the reach-in in core is a single unconditional `args.push(...nativeCredentialEnvArgs())`. The companion `nativeCredentialsEnabled()` predicate gates the gateway skip.
- The seam is `buildContainerArgs` in `src/container-runner.ts`. The credential reach-in goes right after the `TZ` env line; the gateway skip wraps the OneCLI gateway block further down. With the flag on, the gateway is bypassed and the `.env` credential is the sole auth path; with it off, nothing changes.
- **Both edits are required.** Threading the credential without skipping the gateway leaves the gateway's HTTPS_PROXY in place, which MITMs `api.anthropic.com` and overrides the `.env` credential — the agent then fails every turn with "Invalid API key".

## Phase 1: Pre-flight

### Check if already applied

```bash
test -f src/native-credential-proxy.ts \
  && grep -q 'nativeCredentialEnvArgs' src/container-runner.ts \
  && grep -q 'nativeCredentialsEnabled' src/container-runner.ts \
  && echo applied || echo not-applied
```

If it prints `applied`, both the credential reach-in and the gateway skip are wired — skip to Phase 3 (Configure). If `src/native-credential-proxy.ts` exists and `nativeCredentialEnvArgs` is present but `nativeCredentialsEnabled` is not, an older version of this skill was installed *without* the gateway skip — re-apply Phase 2 to add it (this is the fix for an agent that gets "Invalid API key" with native credentials set).

### Confirm the seam exists

```bash
grep -n "args.push('-e', \`TZ=" src/container-runner.ts
```

This should print the `TZ` env line inside `buildContainerArgs`. If it does not, the file has drifted — read `buildContainerArgs` in `src/container-runner.ts` and find the spot where container `-e` env vars are first pushed; the reach-in goes there.

## Phase 2: Apply code changes

### Copy the skill's source and tests into `src/`

```bash
S=.claude/skills/use-native-credential-proxy
cp $S/native-credential-proxy.ts              src/native-credential-proxy.ts
cp $S/native-credential-proxy.test.ts         src/native-credential-proxy.test.ts
cp $S/native-credential-proxy-wiring.test.ts  src/native-credential-proxy-wiring.test.ts
```

`native-credential-proxy.test.ts` is the behavior test (it drives `nativeCredentialEnvArgs()` against a real `.env` read through core's `readEnvFile`). `native-credential-proxy-wiring.test.ts` asserts the one-line reach-in is present in `buildContainerArgs`.

### Import the proxy in `src/container-runner.ts`

Add this import alongside the other local imports (e.g. right after the `./container-config.js` import):

```ts
import { nativeCredentialEnvArgs, nativeCredentialsEnabled } from './native-credential-proxy.js';
```

### Make the one-line reach-in

In `buildContainerArgs`, find the `TZ` env line and add the call right after it:

```ts
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push(...nativeCredentialEnvArgs());
```

`native-credential-proxy-wiring.test.ts` asserts this `args.push(...nativeCredentialEnvArgs())` call exists inside `buildContainerArgs` — delete the reach-in and it goes red.

### Skip the OneCLI gateway when native credentials are on

Threading the credential is necessary but **not sufficient**. The OneCLI gateway block (a little further down in `buildContainerArgs`) injects an `HTTPS_PROXY` + CA cert that routes every container request through the vault. With native credentials on, that proxy MITMs `api.anthropic.com` and overrides the `.env` credential with the vault's — the agent then fails every turn with **"Invalid API key"**. So the gateway must be skipped when the opt-out flag is set.

Find the OneCLI gateway block — it looks like this:

```ts
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });
```

Wrap the whole block in a `nativeCredentialsEnabled()` guard so it is skipped entirely when the opt-out is on:

```ts
  if (!nativeCredentialsEnabled()) {
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });
  } else {
    log.info('OneCLI gateway skipped — native credentials enabled', { containerName });
  }
```

These two edits (the reach-in and this guard) are the only changes to core. `native-credential-proxy-wiring.test.ts` asserts the guard wraps the `applyContainerConfig` call — remove it and the test goes red.

### Add the env flag stub to `.env.example`

Append to `.env.example`:

```bash
# Native credential proxy (.claude/skills/use-native-credential-proxy)
# Opt out of the OneCLI gateway and supply Anthropic credentials from .env.
# When true, the credential below is injected into the container env directly.
# NANOCLAW_NATIVE_CREDENTIALS=true
# One of the following is required when the flag is true:
# ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=
# Optional custom endpoint:
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

### Validate

```bash
pnpm run build
pnpm exec vitest run src/native-credential-proxy.test.ts src/native-credential-proxy-wiring.test.ts
```

The build must be clean and both tests must pass. The build leg confirms the proxy's import of core's `readEnvFile` still resolves; the behavior test confirms the `.env` → `-e` injection; the wiring test confirms the reach-in into `buildContainerArgs` is in place.

## Phase 3: Configure credentials

Ask the user (multiple choice): do they want to use their **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — uses an existing Claude Pro or Max subscription. They run `claude setup-token` in another terminal to mint a token.
2. **Anthropic API key** — pay-per-use API key from console.anthropic.com.

### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have it, add it to `.env` along with the opt-out flag:

```bash
grep -q '^NANOCLAW_NATIVE_CREDENTIALS=' .env && sed -i.bak 's/^NANOCLAW_NATIVE_CREDENTIALS=.*/NANOCLAW_NATIVE_CREDENTIALS=true/' .env && rm -f .env.bak || echo 'NANOCLAW_NATIVE_CREDENTIALS=true' >> .env
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' >> .env
```

`ANTHROPIC_AUTH_TOKEN` is also accepted as an alternative to `CLAUDE_CODE_OAUTH_TOKEN`.

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one, then:

```bash
grep -q '^NANOCLAW_NATIVE_CREDENTIALS=' .env && sed -i.bak 's/^NANOCLAW_NATIVE_CREDENTIALS=.*/NANOCLAW_NATIVE_CREDENTIALS=true/' .env && rm -f .env.bak || echo 'NANOCLAW_NATIVE_CREDENTIALS=true' >> .env
echo 'ANTHROPIC_API_KEY=<key>' >> .env
```

### Optional custom endpoint

For a custom API endpoint, add `ANTHROPIC_BASE_URL=<url>` to `.env` (it is forwarded into the container when present; defaults to `https://api.anthropic.com`).

## Phase 4: Restart and verify

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
# WSL/manual: stop and re-run bash start-nanoclaw.sh
```

### Verify

Send a test message in a registered chat and confirm the agent responds. If the container starts and the agent answers, the credential is reaching the API.

## Troubleshooting

**Container fails to spawn with "no Anthropic credential found in .env":** `NANOCLAW_NATIVE_CREDENTIALS=true` is set but none of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN` is present in `.env`. Add one.

**401 errors from the API:** The credential in `.env` is invalid or expired. For a subscription token, re-run `claude setup-token` and update `CLAUDE_CODE_OAUTH_TOKEN`. For an API key, check it at console.anthropic.com.

**"Invalid API key" on every turn (credential is valid):** The credential reaches the container but is being overridden by the OneCLI gateway's HTTPS_PROXY. This means the gateway skip is missing — confirm `grep nativeCredentialsEnabled src/container-runner.ts` returns the guard around the `applyContainerConfig` block, rebuild, and restart. The host log should print `OneCLI gateway skipped — native credentials enabled` on the next spawn. (To confirm the credential itself is good, call the API directly, bypassing the proxy: `curl https://api.anthropic.com/v1/messages -H "authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: oauth-2025-04-20" -H "content-type: application/json" -d '{"model":"claude-haiku-4-5-20251001","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}'` — a `200` means the token is fine and the proxy is the culprit.)

**Agent still goes through OneCLI:** Confirm `NANOCLAW_NATIVE_CREDENTIALS=true` is in `.env` and the service was restarted. The flag is read from both `process.env` and `.env`; with it unset, `nativeCredentialEnvArgs()` is a no-op, `nativeCredentialsEnabled()` is false, and the OneCLI gateway remains the credential source.

## Removal

See `REMOVE.md` — it deletes the copied files, removes the reach-in and import, strips the `.env` keys, and restarts.
