---
name: manage-channels
description: Wire channels to agent groups, manage isolation levels, add new channel groups. Use after adding a channel, during setup, or standalone to reconfigure.
---

# Manage Channels

Wire messaging channels to agent groups. See `docs/isolation-model.md` for the full isolation model.

Privilege is a **user-level** concept, not a channel-level one (see `src/modules/permissions/db/user-roles.ts`, `src/modules/permissions/access.ts`). There is no "main channel" / "main group" — any user can be granted `owner` or `admin` (global or scoped to an agent group) via `grantRole()`, and messages from unknown senders are gated per-messaging-group by `unknown_sender_policy` (`strict` | `request_approval` | `public`).

## Assess Current State

Read the central DB (`data/v2.db`) using these canonical queries (column names match the schema, not the CLI flags — the `register` command's `--assistant-name` is stored in `agent_groups.name`).

Run each via the in-tree wrapper — the host setup deliberately ships no `sqlite3` CLI:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "<query>"
```

```sql
SELECT id, name AS assistant_name, folder, agent_provider FROM agent_groups;
SELECT id, channel_type, platform_id, name, unknown_sender_policy FROM messaging_groups;
SELECT messaging_group_id, agent_group_id, engage_mode, engage_pattern, session_mode, threads, priority FROM messaging_group_agents;
SELECT user_id, role, agent_group_id FROM user_roles ORDER BY role='owner' DESC;
```

Also check `.env` for channel tokens and `src/channels/index.ts` for uncommented imports.

Categorize channels as: **wired** (has DB entities + messaging_group_agents row), **configured but unwired** (has credentials + barrel import, no DB entities), or **not configured**.

If the instance has no owner yet (`SELECT COUNT(*) FROM user_roles WHERE role='owner' AND agent_group_id IS NULL` returns 0), tell the user they should run `/init-first-agent` first — it stands up the first agent group, promotes the operator to owner, and verifies delivery end-to-end by having the agent DM them. Then return here for any additional channels/groups.

## First Channel (No Agent Groups Exist)

**Delegate to `/init-first-agent`.** It handles: channel choice, operator identity lookup, DM platform id resolution (with cold-DM or pair-code fallback), agent group creation, wiring, and the welcome DM. Return here afterward for any additional channels.

## Channel Defaults: The Two-Level Model

Wiring defaults (engage mode/pattern, threading, `unknown_sender_policy`) resolve through **exactly two levels**:

1. **Adapter declaration** — each channel adapter declares `ChannelDefaults` (separate DM and group contexts, plus a `mentions` capability) in its source file. The adapter copy is skill-installed and user-owned: to change a default install-wide, edit `src/channels/<channel>.ts` and restart. Declarations are never persisted to the DB.
2. **Per-wiring/per-mg values chosen at creation** — every creation surface (`ncl wirings create` / `ncl messaging-groups create`, the `register` wizard step, the approval-card flow, `/init-first-agent`) fills omitted fields from the declaration and stores the result on the row. Pass explicit flags to override one wiring.

There is no third level: existing rows are never re-resolved, so editing a declaration only affects wirings created afterward. The one exception is the **`threads` column**, which stays live — `NULL` means "inherit the declaration at message time".

Channels with no declaration (stale adapter copies) fall back to the legacy behavior; run `/update-skills` to pull current adapters.

### Wiring via ncl

`ncl` requires the **host service to be running** (it connects over a Unix socket):

```bash
ncl messaging-groups create --channel-type <type> --platform-id "<id>" --name "<name>" [--is-group 1]
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <ag-id> [--session-mode <mode>]
```

Omitted `engage_mode`/`engage_pattern`/`unknown_sender_policy` come from the adapter declaration for the right context (DM vs group). Run `ncl wirings help` / `ncl messaging-groups help` for the full flag list.

### Threading override (`--threads`)

`ncl wirings create/update ... --threads true|false` controls whether platform thread ids are honored for this wiring. `true` (in groups) means per-thread sessions and in-thread replies/typing/cards; `false` collapses to a flat session with top-level replies. Omitted = `NULL` = inherit the channel declaration. A wiring can *disable* threads on a threaded platform (Slack, Discord, GitHub), never enable them on a non-threaded one.

Two consequences to warn the user about:

- **Session identity**: sessions are never deleted. Flipping `threads` on a live wiring orphans existing per-thread sessions (or splinters a shared one) — history stays in the old sessions; new messages start fresh ones.
- **`mention-sticky` needs threads**: sticky engagement is keyed on per-thread session existence, so with resolved threads off it would engage once and never disengage. Creation and update coerce `mention-sticky` → `mention` (with a warning) when the effective thread policy is off.

### Mention capability

Each declaration states which mention signal the adapter emits: `platform` (real platform mentions), `dm-only` (only DMs are flagged), or `never`. On a `mentions: 'never'` channel (Linear OAuth apps, WhatsApp personal-number mode, Emacs), `mention`/`mention-sticky` wirings are **inert — they can never engage** — and `ncl` rejects them at create/update with an error citing the declaration. For groups on those channels, use a name pattern instead:

```bash
ncl wirings update <id> --engage-mode pattern --engage-pattern '(?i)^@?<Name>\b'
```

**Renaming an agent group does not update stored patterns.** Declared group patterns containing `{name}` are substituted with the agent group's name *at creation* and stored literally — after `ncl groups update <id> --name <NewName>`, audit that group's wirings for patterns still matching the old name and update them.

## Wire New Channel

For each unwired channel:

1. Read its SKILL.md `## Channel Info` for terminology, how-to-find-id, typical-use, and default-isolation
2. Ask for the platform ID using the platform's terminology
3. Ask the isolation question (see below)
4. Register with the appropriate flags

### Isolation Question

Present a multiple-choice with a contextual recommendation. The three options:

- **Same conversation** (`--session-mode "agent-shared"` + existing folder) — all messages land in one session. Recommend for webhook + chat combos (GitHub + Slack).
- **Same agent, separate conversations** (`--session-mode "shared"` + existing folder) — shared workspace/memory, independent threads. Recommend for same user across platforms.
- **Separate agent** (new `--folder`) — full isolation. Recommend when different people are involved.

Use the channel's `typical-use` and `default-isolation` fields to pick the recommendation. Offer to explain more if the user is unsure — reference `docs/isolation-model.md` for the detailed explanation.

### Register Command

```bash
pnpm exec tsx setup/index.ts --step register -- \
  --platform-id "<id>" --name "<name>" \
  --folder "<folder>" --channel "<type>" \
  --session-mode "<shared|agent-shared|per-thread>" \
  --assistant-name "<name>"
```

The `register` step creates the agent group (reusing it if the folder already exists), the messaging group, and the wiring row. `createMessagingGroupAgent` auto-creates the companion `agent_destinations` row so the agent can address the channel by name.

Omitted engage/policy fields default from the channel adapter's declaration (see "Channel Defaults" above). Optional overrides: `--trigger "<regex>"` (explicit engage pattern), `--engage-mode <pattern|mention|mention-sticky>`, `--is-group <true|false>`, `--unknown-sender-policy <strict|request_approval|public>`. Don't pick a mention mode on a channel whose declaration says `mentions: 'never'` — it can never engage there.

New agent groups are created on the instance default provider (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). To run a group on a different provider, switch it after creation with `ncl groups config update --provider <name>` (e.g. `codex`).

For separate agents, also ask for a folder name and optionally a different assistant name.

## Add Channel Group

When adding another group/chat on an already-configured platform (e.g. a second Telegram group):

1. **Telegram:** ask the isolation question first to determine intent (`wire-to:<folder>` for an existing agent, `new-agent:<folder>` for a fresh one). Run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <intent>`, show the `CODE` from the `PAIR_TELEGRAM_CODE` status block, and tell the user to post `@<botname> CODE` in the target group (or DM the bot for a private chat). Wait for the final `PAIR_TELEGRAM` block. The inbound interceptor has already created the `messaging_groups` row stamped with the Telegram adapter's declared policy (`request_approval` on current adapter copies; `strict` only on stale pre-declaration copies) and upserted the paired user — `register` only needs to add the wiring:

   ```bash
   pnpm exec tsx setup/index.ts --step register -- \
     --platform-id "<PLATFORM_ID>" --name "<group-name>" \
     --folder "<folder>" --channel "telegram" \
     --session-mode "<shared|agent-shared|per-thread>" \
     --assistant-name "<name>"
   ```

2. **Other channels:** read the channel's SKILL.md `## Channel Info` for terminology and how-to-find-id. Ask for the new group/chat ID, ask the isolation question, then register.

## Change Wiring

1. Show current wiring (agent_groups × messaging_group_agents)
2. Ask which channel to move and to which agent group
3. Delete the old `messaging_group_agents` entry, create a new one
4. Note: existing sessions stay with the old agent group; new messages route to the new one. The `agent_destinations` row created for the old wiring is NOT automatically removed — if you want the old agent to stop seeing the channel as a named target, delete it from `agent_destinations` manually.

## One-Time Check: Legacy Mis-Wired WhatsApp Groups

Installs that approved WhatsApp group registration cards before the channel-defaults model wired those groups as `engage_mode='pattern'`, `engage_pattern='.'` — respond-to-everything (the card flow couldn't tell groups from DMs on non-threaded platforms). Check once:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT mga.id, mg.platform_id, mg.name FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id = mga.messaging_group_id WHERE mg.channel_type='whatsapp' AND mg.is_group=1 AND mga.engage_mode='pattern' AND mga.engage_pattern='.'"
```

For any hit the operator didn't deliberately configure as always-on, offer the repair options in `/add-whatsapp`'s "Migration audit" section (flip to mention/name-pattern engagement, or delete the wiring).

## Show Configuration

Display a readable summary showing:

- **Agent groups** with their wired channels (from `messaging_group_agents`)
- **Configured-but-unwired** channels (credentials present, no DB entities)
- **Unconfigured** channels
- **Privileged users**: `SELECT user_id, role, agent_group_id FROM user_roles ORDER BY role='owner' DESC`
