---
name: init-first-agent
description: Walk the operator through creating the first NanoClaw agent for a DM channel — resolve the operator's channel identity, wire the DM messaging group to a new agent, and trigger a welcome DM via the normal delivery path. Use after channel credentials are configured and the service is running.
---

# Init First Agent

Stand up the first NanoClaw agent for a channel and verify end-to-end delivery by having the agent DM the operator. Everything the skill does is idempotent — rerunning is safe.

## Prerequisites

- **Service running.** Check: `launchctl list | grep "$(. setup/lib/install-slug.sh && launchd_label)"` (macOS) or `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux). If stopped, tell the user to run `/setup` first.
- **Target channel installed.** At least one `/add-<channel>` skill has run, credentials are in `.env`, and the adapter is uncommented in `src/channels/index.ts`.
- **Adapter connected.** Tail `logs/nanoclaw.log` — look for a recent `channel setup` / `adapter connected` line for the target channel.

## 1. Pick the channel

Read `src/channels/index.ts` to find enabled channels (uncommented imports). Cross-check `.env` for the relevant credentials.

AskUserQuestion: "Which channel should host the welcome DM?" with one option per enabled channel (Discord, Slack, Telegram, WhatsApp, Webex, Teams, Google Chat, Matrix, iMessage, Resend, …).

Record the choice as `CHANNEL` (lowercase, e.g. `discord`).

## 2. Ask for the operator's identity

Read the channel's own skill for its `## Channel Info > how-to-find-id` section (e.g. `.claude/skills/add-discord/SKILL.md`, `.claude/skills/add-telegram/SKILL.md`). Show those instructions to the user in plain text.

Then ask in plain text (NOT `AskUserQuestion` — these are free-form):

1. **Your user id on this channel** — e.g. a Discord user ID, Telegram user ID, Slack user ID. Record as `USER_HANDLE`.
2. **Your display name** — human name, used to name the agent group (`dm-with-<normalized>`) and as the welcome-message addressee. Record as `DISPLAY_NAME`.
3. **Agent persona name** — the assistant's display name. Default: `DISPLAY_NAME`. Record as `AGENT_NAME`.

## 3. Resolve the DM platform id

This depends on whether the channel supports cold DM via `adapter.openDM`.

**Channels without cold DM (direct-addressable): telegram, whatsapp, imessage, matrix, resend.** The user handle doubles as the DM chat id. Set:

```
PLATFORM_ID=${CHANNEL}:${USER_HANDLE}
```

Skip to step 4.

**Channels with cold DM (resolution-required): discord, slack, teams, webex, gchat.** The bot can DM cold at runtime via Chat SDK, but this skill runs standalone — it can't call the adapter. Two resolutions:

### 3a. User DMs the bot once (Discord / Slack / Teams / Webex / gChat)

Tell the user:

> Send any single message to the bot as a DM from your account on `${CHANNEL}`. The router will record the DM as a messaging group. Reply `done` here when you've sent the message.

Wait for the user's confirmation. Then look up the most recent DM messaging groups:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, platform_id, name, created_at FROM messaging_groups WHERE channel_type='${CHANNEL}' AND is_group=0 ORDER BY created_at DESC LIMIT 5"
```

Show the top rows to the user and confirm which `platform_id` is theirs (usually the most recent). Record as `PLATFORM_ID`. If none appeared, check `logs/nanoclaw.log` for `unknown_sender` drops — the adapter might be rejecting inbound due to connection or permission issues.

### 3b. Telegram pair-code path (if the user prefers not to DM first)

For Telegram only, there's an existing pair-code primitive. When you run this tool, take the output and extract the pairing code. Then show it to the user in plain text and ask the user to send the code in the Telegram chat to complete the pairing.

```bash
npx tsx setup/index.ts --step pair-telegram -- --intent new-agent:dm-with-<folder>
```

Parse the `PAIR_TELEGRAM_ISSUED` status block for `CODE` and follow the `REMINDER_TO_ASSISTANT` line in that block. Then wait for the `PAIR_TELEGRAM` block — read `PLATFORM_ID` and `PAIRED_USER_ID` from it. telegram.ts's interceptor has already upserted the user and granted owner if none existed yet. Use `PLATFORM_ID` and `PAIRED_USER_ID` directly in step 4.

## 4. Run the init script

```bash
npx tsx scripts/init-first-agent.ts \
  --channel "${CHANNEL}" \
  --user-id "${CHANNEL}:${USER_HANDLE}" \
  --platform-id "${PLATFORM_ID}" \
  --display-name "${DISPLAY_NAME}" \
  --agent-name "${AGENT_NAME}"
```

Add `--welcome "System instruction: ..."` to override the default welcome prompt.

The script:
1. Upserts the `users` row and grants `owner` role if no owner exists.
2. Creates the `agent_groups` row and calls `initGroupFilesystem` at `groups/dm-with-<name>/`.
3. Reuses or creates the DM `messaging_groups` row.
4. Wires them via `messaging_group_agents` (which auto-creates the companion `agent_destinations` row).
5. Hands the welcome message to the running service via its CLI socket (`data/cli.sock`), targeting the DM messaging group. The service routes it into the DM session, which wakes the container synchronously. If the socket isn't reachable (service down), falls back to a direct `inbound.db` write that the next host sweep picks up.

Show the script's output to the user.

## 5. Verify

The welcome DM is queued synchronously; the only wait is container cold-start (~60s on first launch) before the agent processes the message and the reply flows through `outbound.db` to the channel.

Do not tail the log or poll in a sleep loop. Ask the user in plain text:

> The welcome DM should arrive shortly. Let me know when you've received it (or if it doesn't arrive within two minutes).

Wait for the user's reply. If they confirm receipt, the skill is done.

If they say it didn't arrive, then diagnose using the DB directly (no waiting loops required — the message either delivered or it didn't):

- `pnpm exec tsx scripts/q.ts data/v2-sessions/<agent-group-id>/sessions/<session-id>/outbound.db "SELECT id, status, created_at FROM messages_out ORDER BY created_at DESC LIMIT 5"` — check for stuck `pending` rows. Replace `<agent-group-id>` and `<session-id>` with the values from the script's output.
- `grep -E 'Unauthorized channel destination|container.*exited|error' logs/nanoclaw.log | tail -20` — look for ACL rejections or container crashes.
- `ls data/v2-sessions/<agent-group-id>/sessions/*/outbound.db` — confirm the session exists.

## Troubleshooting

**"Missing required args"** — the script wants `--channel`, `--user-id`, `--platform-id`, `--display-name` at minimum. Re-check the command you assembled.

**No `messaging_groups` row appears after the user DMs (step 3a)** — the router silently drops messages from unknown senders under `strict` policy but still creates the `messaging_groups` row. If the row is missing entirely, the adapter isn't receiving the inbound message. Check `logs/nanoclaw.log` for adapter errors (auth, gateway disconnect, rate limit).

**Owner already exists** — `hasAnyOwner()` returned true, so the grant is skipped silently. That's fine; the script still creates the agent and wiring. Reassigning ownership needs a separate flow (not this skill).

**Wrong person got the welcome DM** — the `--platform-id` you passed is someone else's DM channel. Rerun with the correct one; the script is idempotent on user/messaging-group/agent-group but writes a new session welcome each run.

**Agent group name collision** — if `dm-with-<display-name>` already exists (e.g. rerunning with the same display name), the script reuses it. Pass a different `--display-name` to get a distinct folder.
