---
name: add-dial-number
description: Add another phone number to an existing Dial channel — a second (or third) public line for the agent, so one NanoClaw install answers SMS and AI voice calls on multiple numbers. Use when Dial is already installed and the operator wants an additional number (e.g. a personal line plus a support line). Requires the Dial channel to already be installed (see /add-dial).
---

# Add another Dial number

One NanoClaw install can serve **multiple Dial numbers** at once. Each number is
its own **public, threaded line** — its own messaging group (`platform_id` = the
Dial number), each remote correspondent a thread inside it — and the agent
replies from whichever number a person texted.

This skill is for adding a number to an **already-installed** Dial channel. Its
mechanical steps use `nc:` directives so an agent and the deterministic skill
engine perform the same validated, idempotent workflow.

## Pre-flight

Confirm Dial is installed and registered. If this fails, run `/add-dial` first,
then retry:

```nc:run effect:check
test -f src/channels/dial.ts && grep -q "import './dial.js';" src/channels/index.ts
```

Adding another number requires the multi-number adapter, which routes on the
line each event arrived on (`data.to`). If this fails, run `/update-skills` to
refresh the installed adapter, rebuild, and retry:

```nc:run effect:check
grep -q "eventLine" src/channels/dial.ts
```

Resolve the Dial CLI and the install's user-agent token once for every account
request below:

```nc:run capture:dial_path validate:^/.+ effect:fetch
command -v dial
```

```nc:run capture:dial_ua validate:^nanoclaw/\S+$ effect:fetch
node -p "'nanoclaw/'+(require('./package.json').version||'unknown')" 2>/dev/null || echo nanoclaw/unknown
```

## Choose the number

List the account's current numbers:

```nc:run capture:dial_numbers effect:fetch
DIAL_USER_AGENT={{dial_ua}} "{{dial_path}}" number list --json | jq -r 'if (.numbers|length)==0 then "none" else [.numbers[].number] | join(", ") end'
```

Tell the operator what is available. Buying a number spends account funds, so
leave that explicit: if they need a new one, they should purchase it with
`dial number purchase --inbound-instruction "…" --explicit-programmatic-consent
"<account-holder consent attestation>"`, then enter the returned number below.

```nc:operator
Dial numbers on this account: {{dial_numbers}}. Choose one that is not already wired to NanoClaw. If you need a new number, purchase it first; this may charge the Dial account.
```

```nc:prompt platform_id validate:^[+][1-9]\d{6,14}$ normalize:trim
Which Dial number should be added? Enter its E.164 value, for example +14155550123.
```

Verify that the chosen number belongs to the signed-in account:

```nc:run effect:check
DIAL_USER_AGENT={{dial_ua}} "{{dial_path}}" number list --json | jq -e --arg number '{{platform_id}}' '.numbers[] | select(.number==$number)' >/dev/null
```

## Choose the agent

List the agent groups:

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet" else [.data[] | "\(.id) (\(.name))"] | join(", ") end'
```

```nc:operator
Agent groups on this install: {{agent_groups}}.
```

```nc:prompt agent_group_id validate:^ag-[A-Za-z0-9-]+$ normalize:trim
Which agent group should answer this number? Enter its ag-… id.
```

Reject a typo before creating anything:

```nc:run effect:check
ncl groups list --json | jq -e --arg id '{{agent_group_id}}' '.data[] | select(.id==$id)' >/dev/null
```

Choose a safe display name and who may start conversations on this line.
`strict` admits only known users; `public` lets anyone who knows the number reach
the agent. The choice belongs to this number and does not change existing lines:

```nc:prompt line_name validate:^[A-Za-z0-9][A-Za-z0-9_.-]*(\x20[A-Za-z0-9][A-Za-z0-9_.-]*)*$ normalize:trim
What should this line be called? Use letters, numbers, spaces, dots, dashes, or underscores.
```

```nc:prompt inbound_access validate:^(strict|public)$ normalize:trim
Who may text this line: strict or public?
```

## Wire the line

Create the threaded Dial messaging group. This is idempotent on the number, so
a re-run returns an existing row without resetting later policy changes:

```nc:run effect:wire
ncl messaging-groups create --channel-type dial --platform-id {{platform_id}} --is-group 1 --name "{{line_name}}" --unknown-sender-policy {{inbound_access}}
```

Wire it to the selected agent group. The adapter's declaration supplies the
thread and engagement defaults:

```nc:run effect:wire
ncl wirings create --channel-type dial --platform-id {{platform_id}} --agent-group-id {{agent_group_id}}
```

## Restart and verify

Restart the service so the new line is picked up consistently:

```nc:run effect:restart
bash setup/lib/restart.sh
```

Verify the exact messaging-group and wiring pair exists:

```nc:run effect:check
mg=$(ncl messaging-groups list --json | jq -er --arg number '{{platform_id}}' '.data[] | select(.channel_type=="dial" and .platform_id==$number) | .id') && ncl wirings list --json | jq -e --arg mg "$mg" --arg ag '{{agent_group_id}}' '.data[] | select(.messaging_group_id==$mg and .agent_group_id==$ag)' >/dev/null
```

The new number now reaches the selected agent as a separate threaded line, and
replies leave from the number that received the message. Existing lines are
unchanged.

## Troubleshooting

- **The multi-number check fails** → run `/update-skills`, rebuild, and retry.
- **The selected number is rejected** → sign in to the correct Dial account or
  purchase the number first, then copy its exact E.164 value.
- **New texts land in an old line or replies use the wrong number** → the running
  service still has the old adapter; refresh it and restart again.
- **New inbound events never arrive** → one `dial listen` daemon covers the
  whole account; confirm `dial doctor --json` reports `listen.running: true` and
  `dial local-target list --json` contains NanoClaw's command target.
- **`ncl` errors** → the host service must be running; `ncl` connects over a
  Unix socket.
