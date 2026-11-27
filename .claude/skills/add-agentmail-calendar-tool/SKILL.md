---
name: add-agentmail-calendar-tool
description: Give chosen NanoClaw agents the calendar of their AgentMail inbox. Installs the `cal` CLI (agenda, create/update/delete events, answer emailed invitations), which uses the same owner-approval rule as /add-agentmail-tool before emailing anyone, keeps a ledger of every write, and provides a `due` task gate for start-time and new-invitation alerts. Requires /add-agentmail-tool. Keyless via the credential gateway; no image rebuild. Idempotent; re-run to add agents.
---

# Add AgentMail Calendar Tool

Every [AgentMail](https://www.agentmail.to) inbox has a calendar. This skill installs the
`agentmail-calendar` container skill with the `cal` CLI. It is a Bun script, so the agent image
needs no new packages and no rebuild. With it, an agent can:

- read its agenda (recurring events expanded),
- create, update and delete events, including all-day and recurring ones,
- answer invitations that were emailed to the inbox,
- get alerts before events start and when new invitations arrive, through `cal due`, a
  scheduled-task gate. Calendar webhooks need a public URL, and the gate doesn't.

**This tool can send real email.** Invitations, cancellations and replies to organizers go out
only for the owner's addresses and `known` contacts. Anyone else needs the owner's recorded OK
(`--approved-by-owner`), the same rule `mail` enforces.

This skill builds on `/add-agentmail-tool`. `cal` reads that skill's per-group
`email/config.json` (inbox, owner addresses, `known` contacts, `lookalike` fragments) and uses
the AgentMail credential it stored in the gateway. It adds no new configuration or credential.

Run this from the NanoClaw repo on the host, not from a chat with an agent. `${CLAUDE_SKILL_DIR}`
below is this skill's directory (`.claude/skills/add-agentmail-calendar-tool`). If your shell
doesn't set it, use that path.

## Pre-flight

`/add-agentmail-tool` must already be applied, and the NanoClaw service must be running:

```bash
test -x container/skills/agentmail/mail && ncl groups list >/dev/null && ls -d groups/*/email/config.json
```

If the first check fails, run `/add-agentmail-tool` first. The listed `config.json` files show
which groups have an inbox. Only those groups can get the calendar.

## 1. Copy the container skill

```bash
mkdir -p container/skills/agentmail-calendar
cp "${CLAUDE_SKILL_DIR}"/container-skills/agentmail-calendar/{SKILL.md,cal,cal.ts,cal.test.ts} container/skills/agentmail-calendar/
chmod +x container/skills/agentmail-calendar/cal
```

`container/skills/` is mounted read-only into every agent container at `/app/skills`. That makes
the CLI `/app/skills/agentmail-calendar/cal` in every group whose skill selection includes it (the
default, `all`, does). For agents without an `email/config.json`, the skill says the calendar
isn't theirs.

Run the CLI's tests on the agent image's Bun:

```bash
IMG="$(bash -c 'source setup/lib/install-slug.sh; container_image_base'):latest"
docker run --rm --entrypoint bun -v "$PWD/container/skills/agentmail-calendar:/s:ro" -w /s "$IMG" test
```

All tests must pass. They run offline against a fake AgentMail API and cover the send guard, the
ledger, `If-Match`, the `due` gate (dedupe, first-run baseline, JSON on failure) and timezone
conversion.

## 2. Tell each chosen agent about its calendar

Ask the operator which of the groups from the pre-flight should get the calendar. For each one,
with `<folder>` from `ncl groups list`, add one line to its standing instructions. Skip any group
whose file already mentions `agentmail-calendar`:

```bash
grep -qs 'agentmail-calendar' groups/<folder>/instructions.prepend.md || printf '\n## Calendar\n\nYour inbox has a calendar. Use the `agentmail-calendar` skill and its `cal` CLI for all scheduling.\n' >> groups/<folder>/instructions.prepend.md
```

## 3. Restart the chosen groups

Standing instructions load when the container starts:

```bash
ncl groups restart --id <group-id>
```

## Verify

From a chat with each chosen agent, ask it to run `cal check`. Expect
`ok: calendar of <inbox> reachable through the gateway (timezone ..., N event(s))`. Then ask it
to put a test event with no attendees on the calendar for tomorrow, list the agenda, and delete
the event. `groups/<folder>/calendar/ledger.jsonl` should show the create and the delete.

Optional, per agent: ask it to set up its calendar watcher. Its skill has the exact
`ncl tasks create --script '/app/skills/agentmail-calendar/cal due --window-min 10'` command.

## Tests

The skill has no in-tree integration point. The container skill is found by the directory scan of
`container/skills/`, its configuration is `/add-agentmail-tool`'s per-group state, and the
credential lives in the gateway. So there is no core line that a registration test could guard.
The bundled `cal.test.ts` is the CLI's own unit test suite (Bun, step 1).

## Troubleshooting

**`cal check` returns 401 or 403.** The gateway has no AgentMail key for this agent. Fix it as in
`/add-agentmail-tool`'s troubleshooting. `cal` uses the same credential as `mail`.

**`cal check` returns 404.** `inbox` in that group's `email/config.json` isn't in the account whose
key is stored.

**`cannot read .../email/config.json`.** That group has no inbox. Set it up with
`/add-agentmail-tool` first.

**`cal: Permission denied`.** The executable bit was lost in the copy. Run
`chmod +x container/skills/agentmail-calendar/cal`.

**An agent invites an outsider without asking.** It can't do that through `cal`. Check
`groups/<folder>/calendar/ledger.jsonl`, which records the recipients and approval text of
every write.

To uninstall, see [REMOVE.md](REMOVE.md).
