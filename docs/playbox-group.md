# Household playbox group

This install has one local household expense agent and one synthetic group chat.
Runtime rows live in `data/v2.db` and are deliberately not committed.

## Fixed identities

- Agent group ID: `305c03b8-8f57-4933-9aea-509ca840c25f`
- Agent folder: `household-expense-agent`
- Messaging group ID: `17855e37-fd79-42d6-9cc9-ede2edc2a472`
- Platform identity: `playbox:household`
- Wiring ID: `d9d42254-6c7e-438a-a31b-1f99ad7a20b6`
- Approved synthetic participants: `playbox:alice`, `playbox:bob`
- Denial fixture: `playbox:guest` (no group membership)

The wiring uses `engage_mode=pattern`, `engage_pattern=.`,
`sender_scope=known`, `session_mode=shared`, and `threads=0`. The messaging
group uses `unknown_sender_policy=strict`. This gives Alice and Bob one shared
conversation while leaving Guest unable to wake the agent.

## Non-secret container configuration

The group uses provider `opencode`, model
`openrouter/deepseek/deepseek-v4-flash`, timezone `Asia/Hong_Kong`, and the
single `ndexpense` MCP server stamped by
`templates/household/expense-agent/.mcp.json`. The MCP configuration contains
only the staging API base URL; it contains no credential, authorization header,
account identity, or caller-selectable URL.

OpenCode's provider and main/small model environment are stored in the local
owner-only `.env`; that file contains configuration but no credential and is
ignored by Git.

## Verification

Start the host as the dedicated account with the development gates:

```bash
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household \
  NODE_ENV=development NANOCLAW_PLAYBOX=true \
  NANOCLAW_EGRESS_LOCKDOWN=false CONTAINER_CPU_LIMIT=2 \
  CONTAINER_MEMORY_LIMIT=4g pnpm dev
```

An Alice smoke message produced a shared session and a `Message routed` log
for `Household Expense Agent` without logging the body. A Guest message
produced `MESSAGE DROPPED — unknown sender (strict policy)` with
`accessReason=not_member`. Container wake then stopped at the intentionally
deferred OneCLI credential gate (401); no live model or backend assertion is
claimed.

The playbox listener is `127.0.0.1:3210` only. Verify both the positive bind
and the negative non-loopback case:

```bash
ss -ltnp | grep ':3210'
curl --fail http://127.0.0.1:3210/
curl --fail --connect-timeout 2 "http://$(hostname -I | awk '{print $1}'):3210/"
```

The last command must fail to connect.

## Inspect and reset

```bash
cd /srv/nanoclaw-household
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household pnpm ncl groups list --json
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household pnpm ncl groups config get \
  --id 305c03b8-8f57-4933-9aea-509ca840c25f --json
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household pnpm ncl wirings list --json
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household pnpm ncl members list --json
```

To reset only browser events and fault injections while the playbox is running:

```bash
curl --fail -X POST http://127.0.0.1:3210/api/reset
```

Deleting the agent group is destructive and cascades its central-DB sessions,
wiring, roles, and memberships. Do it only when intentionally rebuilding this
playbox, after stopping NanoClaw and backing up `data/`:

```bash
runuser -u nanoclaw -- env HOME=/var/lib/nanoclaw-household pnpm ncl groups delete \
  --id 305c03b8-8f57-4933-9aea-509ca840c25f
```

The ignored `groups/household-expense-agent/` directory and matching session
state are separate on-disk cleanup targets; the CLI does not delete them.
