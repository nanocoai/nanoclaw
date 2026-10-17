---
name: setup-private-plugins
description: One-time-per-host setup that registers a GitHub PAT in the OneCLI vault so private github plugin clones work in NanoClaw containers. Triggers on "private plugins", "github auth for plugins", "setup private plugin auth".
---

# /setup-private-plugins

Wires the OneCLI vault entry that lets the SDK clone private github plugins from inside a NanoClaw container, without ever putting the token on disk in the container or in `container.json`. Run once per host.

## Background — why this is needed

Github's git smart-HTTP only accepts HTTP Basic auth (NOT `Bearer`). The OneCLI gateway intercepts container HTTPS traffic and can inject auth headers — but the existing `GitHub` secret most operators have (with hostPattern `api.github.com` and `Bearer {value}`) covers the REST API only, not git clones from `github.com`.

This skill installs a separate vault entry:

| Field | Value |
|---|---|
| hostPattern | `github.com` |
| headerName | `Authorization` |
| valueFormat | `Basic {value}` |
| value | base64-encoded `x-access-token:<your-PAT>` |

After install, the OneCLI gateway injects `Authorization: Basic ...` into any container's HTTPS request to `github.com`, including the SDK's plugin clones. No token lands on disk in the container.

## Run

```bash
pnpm exec tsx scripts/setup-private-plugins.ts
```

The script:

1. Checks for an existing `github.com` Basic-auth entry. If present, prompts to skip (or pass `--force` to overwrite).
2. Reads your github PAT from `gh auth token` (the github CLI's stored credentials), OR pass `--token <pat>` explicitly.
3. Encodes `base64("x-access-token:" + token)`.
4. Calls `onecli secrets create` with the right shape.
5. Reports success.

## With explicit token

```bash
pnpm exec tsx scripts/setup-private-plugins.ts --token gho_yourPATHere
```

## Token requirements

The PAT needs `repo` scope (read-only is enough for clones). Fine-grained PATs work; classic PATs work.

## Verification

```bash
onecli secrets list | grep -A5 github.com
```

Should show your new entry with `hostPattern: "github.com"` and `valueFormat: "Basic {value}"`.

End-to-end: register a private repo via `/install-plugin --source` (or `/add-marketplace`) and send a message to the group. The SDK's `plugin_install:installed` event should fire. If it fires `plugin_install:failed` with a 401-style error, the secret isn't being matched — verify the hostPattern and re-run with `--force`.

## Restart not required

OneCLI looks up secrets per request, so the new entry is live immediately. No NanoClaw restart needed.

## Token rotation

When you rotate the PAT, re-run with `--force` (or `--force --token <new-pat>`). The script updates the vault entry; the next container clone uses the new token.
