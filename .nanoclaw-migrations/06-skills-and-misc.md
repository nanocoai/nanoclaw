# 06 — Skills and Miscellaneous Local Deltas

Everything in `git diff --name-only e263352a..HEAD` not covered by the pilot-activation,
channels, codex, or quota-fallback sections.

## 1. Container skills (local-only — copy directories as-is)

Copy these directories verbatim from the old tree into the new checkout. Container skills
under `container/skills/` are auto-mounted into agent sessions; no registration needed
(they're picked up by the skills sync at container spawn — verify against the group's
`skills` selection in container config if a group uses an explicit skill list instead of
`'all'`).

- `container/skills/person-dossier/` — `SKILL.md` (123 lines). Elia's career-intelligence
  person-research skill (Apollo via OneCLI vault, no LinkedIn automation).
- `container/skills/voice-messages/` — `SKILL.md` (84 lines) + `instructions.md` (9 lines).
  Voice replies via OpenAI TTS producing Ogg/Opus; pairs with the WhatsApp PTT delta in
  `04-channels.md` §3 (outbound `.opus`/`.ogg` render as native voice notes).

No local-only skill dirs exist under `.claude/skills/` relative to the merge base — host
skills there all came from upstream or skill branches. (origin/main meanwhile added
`add-clidash`, `add-rtk`, `learn`, `migrate-memory` — you get those for free.)

## 2. `src/modules/approvals/primitive.ts` — APPROVAL_PREFERRED_CHANNEL (local customization)

Intent: the operator drives agents from WhatsApp but wants approval prompts on Telegram.
An env-pinned channel wins over the origin-channel heuristic in `pickApprovalDelivery`.
Reapply into upstream's version of the file (function may have moved; upstream migration
018 added `approver_user_id` — the tie-break loop structure should be recognizable).

Add import:

```ts
import { readEnvFile } from '../../env.js';
```

Add above `pickApprovalDelivery`:

```ts
/**
 * Operator-set channel that always wins over the origin-channel heuristic.
 * When set, approvals are routed there regardless of where the agent is being
 * driven from. Empty string = no preference, fall back to origin matching.
 *
 * Read once at module load; changes require a host restart (same as every
 * other env-driven config in nanoclaw).
 */
const PREFERRED_CHANNEL = (readEnvFile(['APPROVAL_PREFERRED_CHANNEL']).APPROVAL_PREFERRED_CHANNEL ?? '')
  .trim()
  .toLowerCase();
```

At the top of `pickApprovalDelivery`, before the origin-channel loop:

```ts
  if (PREFERRED_CHANNEL) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== PREFERRED_CHANNEL) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
```

And update the doc comment to describe the 3-step tie-break (pinned channel → origin
channel → first reachable). Installation side: `.env` may set
`APPROVAL_PREFERRED_CHANNEL=telegram` (check the live `.env`; the code no-ops when unset).

## 3. `src/modules/mount-security/index.ts` — defensive guard (local fix)

In `findAllowedRoot`, at the top of the `for (const root of allowedRoots)` loop:

```ts
    if (!root.path) {
      // Defensive: a malformed allowlist entry without a `path` field would
      // otherwise crash expandPath() with TypeError, taking down the whole
      // mount-validation path and any container spawn that depends on it.
      // Log + skip so a single bad entry can't deny service.
      log.warn('Allowlist entry missing path field — skipping', { root });
      continue;
    }
```

Check first whether upstream already added an equivalent guard; skip if so.

## 4. `setup/register-claude-token-update.sh` — new local script (copy verbatim)

Ops tool for the "vault Anthropic OAuth token expires every ~8h" problem: captures a
long-lived `claude setup-token` token via PTY and UPDATES the existing OneCLI vault secret
(default `SECRET_ID=eb301f70-4f02-40b8-8580-5fa768193d5c`, overridable via env). Copy
as-is, `chmod +x`. Note the hardcoded default secret id is installation-specific — fine to
keep since it's this machine's vault.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Variant of register-claude-token.sh that UPDATES the existing Anthropic
# vault secret with a long-lived `claude setup-token` token, instead of
# creating a duplicate. Run this in a real terminal (not inside Claude Code).
#
# The long-lived sk-ant-oat… token does not expire like the ~8h subscription
# OAuth access token, so once it's in the vault the agent stops going silent.

export PATH="/home/exedev/.local/bin:$PATH"

SECRET_ID="${SECRET_ID:-eb301f70-4f02-40b8-8580-5fa768193d5c}"

command -v onecli >/dev/null \
  || { echo "onecli not found." >&2; exit 1; }
command -v claude >/dev/null \
  || { echo "claude CLI not found." >&2; exit 1; }
command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

cat <<'EOF'
A sign-in link will appear. Open it in your browser, sign in with your
Claude account, and paste back the code if asked. When done, the token is
saved to your OneCLI vault automatically.

Press Enter to continue.
EOF
read -r _ </dev/tty

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "claude setup-token" "$tmpfile"
else
  script -q "$tmpfile" claude setup-token
fi

token=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
        | tr -d '\n\r' \
        | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
        | tail -1 || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got long-lived token: ${token:0:16}…${token: -4}"
echo "Updating vault secret $SECRET_ID…"

onecli secrets update --id "$SECRET_ID" --value "$token"

echo "Done. The agent now uses a non-expiring token."
```

## 5. `container/Dockerfile` deltas

Local diff vs merge base has three pieces:

1. **`ARG CODEX_VERSION=0.124.0` + its `RUN pnpm install -g "@openai/codex@…"` layer** —
   stock `/add-codex` output; the skill re-adds it (see 05-codex-provider.md).
2. **Gmail MCP block** — stock `/add-gmail-tool` output (verified identical to the skill's
   SKILL.md instructions, including the `zod-to-json-schema@3.22.5` pin rationale). Re-run
   `/add-gmail-tool` rather than hand-porting:
   ```dockerfile
   ARG GMAIL_MCP_VERSION=1.1.11
   ...
   RUN --mount=type=cache,target=/root/.cache/pnpm \
       pnpm install -g \
           "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
           "zod-to-json-schema@3.22.5"
   ```
3. **`ARG CLAUDE_CODE_VERSION=2.1.128` → `2.1.197`** — genuine local customization
   (the 2026-07-02 container upgrade; local `container/agent-runner/package.json` was
   bumped in lockstep: `@anthropic-ai/claude-agent-sdk` `^0.2.128` → `0.3.197`, plus
   `@anthropic-ai/sdk@0.106.0` added and `@modelcontextprotocol/sdk` → `^1.29.0`).
   **Check upstream main's current pins first** — if upstream already ≥ 2.1.197, skip; if
   still older, reapply the bump: edit the two `ARG`/`package.json` values, then
   `cd container/agent-runner && bun install` and commit `bun.lock`. Then
   `./container/build.sh`. Note: `@anthropic-ai/sdk` was added for the quota-fallback
   feature's usage checks — if the quota-fallback guide isn't being reapplied, that dep
   may be unnecessary.

## 6. Stock skill outputs — DO NOT hand-port (installed by skills)

- `setup/groups.ts` — byte-identical to origin/channels (WhatsApp skill payload).
- Host `package.json` dep additions: `@chat-adapter/telegram@4.26.0` (telegram skill),
  `@whiskeysockets/baileys@7.0.0-rc.9`, `pino@9.6.0`, `qrcode@1.5.4`, `@types/qrcode@1.5.6`
  (whatsapp skill). Version pins may have moved on the channels branch — take the skill's
  current pins.
- `src/channels/index.ts` barrel imports — added by the skills.

## 7. Quota-fallback spillover (documented in the quota-fallback guide — listed for completeness)

These changed files are entirely or mostly quota-fallback and are NOT covered here:
`src/db/migrations/017-fallback-provider.ts` (renumber → 021, see 03 §migration),
`fallback_provider` plumbing in `src/types.ts`, `src/db/container-configs.ts`,
`src/container-config.ts`, `src/backfill-container-configs.ts`, `src/container-runner.ts`
(fallback contribution merge), `src/cli/resources/groups.ts` (`--fallback-provider`, and
`--image-tag none` clearing), `container/agent-runner/src/config.ts` (`fallbackProvider`),
`container/agent-runner/src/providers/types.ts` (`quota_status` event), plus
`quota.ts`, `handoff.ts`, `poll-loop.ts`, `index.ts`, `messages-out.*`, `session-state.ts`,
`integration.test.ts`, `quota-fallback.test.ts`, `providers/claude.ts` and the `transfer/`
patch files + bundle.

## 8. Installation-specific / intentionally NOT migrated

- `.claude/settings.json`, `.claude/scheduled_tasks.lock` (deleted) — local harness state.
- `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` (deleted locally) — live group data;
  the `groups/` tree is data, not code. Carry the directory over as data if the new
  checkout replaces the working tree.
- `HANDOFF-*.md`, `NEXT-SESSION-STATUS.md`, `shellanoo-self-awareness-prompt.txt`,
  `transfer/` — session notes / transfer artifacts, not code to migrate.
- `pnpm-lock.yaml` — regenerated by installs.
