---
name: add-dial-tool
description: Give chosen NanoClaw agents a real phone number as a container tool — the `dial` CLI baked into the agent image plus OneCLI credential injection for api.getdial.ai, attached only to the agents you pick, so they can send SMS, place AI voice calls, and receive verification codes from inside the sandbox. Independent of the Dial channel; idempotent; re-run to change which agents may use it. Use when the user wants agents to text, call, or run `dial …` from a chat, without wiring Dial as a messaging channel.
---

# Add Dial Tool

Installs Dial as a **container tool**: the `dial` CLI on the agent's `PATH`, the
`dial-cli` skill so the agent knows how to drive it, and an OneCLI credential
attached only to the agents you choose, so their in-container calls are injected
keyless. Independent of the Dial **channel**
(`/add-dial`) — install this alone. Idempotent: re-run it to change which agents
may use Dial.

**This tool spends money and reaches real people.** An agent with Dial access can
text and call any number and buy more numbers, billed to the Dial account. The
CLI and the skill file land in every agent's container, but the **key** is
injected per agent by OneCLI, so the operator chooses which agents get it. The
key is attached to those agents only; every other agent, and every agent group
created later, gets no Dial key, and the gateway answers its Dial requests
with the error code `access_restricted`.

Run this from the NanoClaw repo on the host (not from a chat with an agent — the
container can't install itself). The mechanical steps carry `nc:` directive
fences: an agent reads the prose and applies them, and a parser can apply them
deterministically from the same document. Every directive is idempotent, so the
whole skill is safe to re-run; anything a parser can't apply falls back to the
prose beside it.

## Pre-flight

OneCLI is required for credential injection — without it there is no way to hand
the key to a container without putting it in an env var. This must succeed before
anything else runs:

```nc:run effect:check
command -v onecli >/dev/null
```

If it fails, tell the user to run `/init-onecli` first, then retry. Stop here.

This skill attaches the Dial key to chosen agents through the OneCLI agent
grants API, which gateway 1.44 added; NanoClaw pins 1.45. On an older gateway
every agent in `all` mode would receive a new key, and the grants commands do not
exist. A 1.44+ gateway converts `all`-mode agents to grants once, on its first
start; an agent still in `all` mode means that conversion has not finished, and
it too would receive the key. So run the shared grants check before anything is
written: it reads the version of the gateway the `onecli` CLI talks to, checks
that no agent is in `all` mode, and checks that the `onecli` CLI has the grants
commands.
The Dial sign-up and credential steps below use the captured version, so they
cannot run when this check fails:

```nc:run capture:onecli_gateway validate:^[0-9]+\.[0-9]+\.[0-9]+$ effect:fetch
sh .claude/skills/add-onecli/scripts/check-grants-gateway.sh /add-dial-tool
```

If it fails, show the user the message as it is and stop. Do not work around it
by attaching the Dial key by hand to every agent: which agents hold the key is
the only thing that keeps the ones you did not choose away from Dial.

Calls this setup makes to Dial identify the install. The `dial` CLI prepends
`DIAL_USER_AGENT` to its own token, so the account's requests stay attributable
to this NanoClaw install in Dial's server-side logs. Resolve the token once
(`nanoclaw/<version>`; an unreadable `package.json` degrades to
`nanoclaw/unknown` rather than blocking the install):

```nc:run capture:dial_ua validate:^nanoclaw/\S+$ effect:fetch
node -p "'nanoclaw/'+(require('./package.json').version||'unknown')" 2>/dev/null || echo nanoclaw/unknown
```

Prefix every `dial` command below with `DIAL_USER_AGENT={{dial_ua}}`.

## Choose which agents may use Dial

List the agent groups (the NanoClaw service must be running — `ncl` talks to it
over its socket):

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet" else [.data[] | "\(.id) (\(.name))"] | join(", ") end'
```

Ask the operator which of them may use Dial. Say plainly what they are granting,
and ask even when there is a single agent:

```nc:operator
Agents on this install: {{agent_groups}}. Giving an agent Dial lets it text and call any number and buy numbers, billed to your Dial account. Agents you leave out do not get the Dial key (reversible by running /add-dial-tool again). Agents created after this run do not get Dial until you run /add-dial-tool again.
```
```nc:prompt dial_agents validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ normalize:trim
Which agents may use Dial? Enter agent ids separated by commas with no spaces (the `ag-…` column), `all` for every agent that exists now, or `none` to install the tool with no agent holding the key for now.
```

`all` and `none` cannot be mixed with ids, and an empty answer is never
"everyone". A typo must not silently open or close anything, so every id named
must be a real agent group, and `all` is expanded to the groups that exist now,
so a group created while the skill runs is not included. The checked answer is
captured, and every step that
installs, signs in, or writes a credential below depends on the capture: a bad
answer stops them all, nothing is written:

```nc:run capture:dial_scope validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ effect:fetch
A=$(printf '%s' '{{dial_agents}}' | tr -d ' '); G=$(ncl groups list --json --limit 100000) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; for w in $(printf '%s' "$A" | tr ',' ' '); do case "$w" in all|none) ;; *) printf '%s' "$G" | jq -e --arg id "$w" '.data[] | select(.id==$id)' >/dev/null || { echo "unknown agent group '$w' — see: ncl groups list" >&2; exit 1; }; esac; done; case ",$A," in *,all,*) A=$(printf '%s' "$G" | jq -r '[.data[].id] | join(",")'); [ -n "$A" ] || A=none;; esac; printf '%s\n' "$A"
```

## Install the Dial CLI on the host

The host needs the `dial` CLI to sign in: `dial auth login` / `dial auth
verify-otp` write the host auth file that the credential step below reads. Pinned
to the same version the agent image gets, so host and sandbox agree:

```nc:run effect:external
: "OneCLI gateway {{onecli_gateway}}, Dial agents {{dial_scope}}"; command -v dial >/dev/null || npm install -g @getdial/cli@0.37.0
```

## Sign in to Dial

Dial's CLI owns the account credential (an auth file it writes on sign-in).

### Check the host sign-in

Is this host already signed in?

```nc:run capture:signed_in=.auth.signedIn validate:^(true|false)$ effect:fetch
DIAL_USER_AGENT={{dial_ua}} dial doctor --json
```

### Read the account

If it **is**, read which account — that account's key is what the chosen agents
will use:

```nc:run capture:connected_email=.auth.email when:signed_in=true effect:fetch
DIAL_USER_AGENT={{dial_ua}} dial doctor --json
```
```nc:operator when:signed_in=true
This host is signed in to Dial as {{connected_email}}; the agents you chose will use that account. To give them a different account, run `dial auth login <email> --force` and `dial auth verify-otp --code <code>` on the host first, then run /add-dial-tool again. The Dial key is updated in place, so a different Dial account switches every agent that holds the Dial key to it, another install's agents on this gateway included.
```

### Send the code

If it is **not**, verify an email with a one-time code:

```nc:operator when:signed_in=false
The Dial key on this OneCLI gateway is updated in place, so signing in to a different Dial account than the one already used here switches every agent that holds the Dial key to it, another install's agents on this gateway included.
```

Collect the email:

```nc:prompt owner_email validate:^[^@\s]+@[^@\s]+\.[^@\s]+$ when:signed_in=false
What's your email? Dial sends a one-time code to verify it. By continuing you create a Dial account and agree to Dial's Terms of Service (https://getdial.ai/terms) and Privacy Policy (https://getdial.ai/privacy).
```

Send the code (`--force` re-sends even if a prior code is pending):

```nc:run effect:external when:signed_in=false
: "OneCLI gateway {{onecli_gateway}}, Dial agents {{dial_scope}}"; DIAL_USER_AGENT={{dial_ua}} dial auth login {{owner_email}} --force
```

### Verify the code

Collect the code:

```nc:prompt otp validate:^\d{6}$ when:signed_in=false
Enter the 6-digit code from your email
```

Verify it. Do **not** pass `--agent nanoclaw` here: this skill owns the container
`dial-cli` skill, and `--agent` would drop a second, unmanaged copy next to it:

```nc:run effect:external when:signed_in=false
: "OneCLI gateway {{onecli_gateway}}, Dial agents {{dial_scope}}"; DIAL_USER_AGENT={{dial_ua}} dial auth verify-otp --code {{otp}}
```

## Put the CLI and its skill in the agent image

The agent's global Node CLIs install from `container/cli-tools.json`, not from
hand-edited Dockerfile layers. Add the pinned Dial CLI — idempotent on `name`, so
a re-run is a no-op. `@getdial/cli` has no native postinstall, so no `onlyBuilt`:

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "@getdial/cli", "version": "0.37.0" }
```

The version (`0.37.0`) is the canonical pin — this document is the source of
truth; the host install above uses the same one.

Mount the sandbox-aware `dial-cli` skill so the agent knows the CLI runs keyless
in there and never asks for credentials. `container/skills/` is mounted read-only
into every agent container (at `/app/skills`) — which is why the key, not the
skill file, is what gets scoped per agent:

```nc:copy
container-skills/dial-cli/SKILL.md -> container/skills/dial-cli/SKILL.md
```

Rebuild the image so the CLI lands. On an install that fetches a published image
this adds Dial as a layer on top of it; on one that builds its own it rebuilds:

```nc:run effect:build
./container/build.sh
```

## Register the credential with OneCLI

Read the API key from the host auth file — the single source of truth, written
by `dial auth login` / `dial auth verify-otp` — and store it in the OneCLI vault
of the gateway the `onecli` CLI writes to (the one the check above read), for
`api.getdial.ai`, through
[scripts/dial-secret.ts](scripts/dial-secret.ts). It always writes the value:
an existing "Dial API" secret may hold a previous account's key (re-onboarding,
switching accounts, or rotating the key). The existing entry is updated in place,
so its id and grants stay, including another install's on a shared gateway; a new
one is attached to no agent. The key goes straight from the file to the
gateway's API, never on argv or stdout. The step prints only the secret id, which
the attach step below uses, so the attach cannot run with any other key:

```nc:run capture:dial_secret validate:^[A-Za-z0-9_-]{1,128}$ effect:external
: "OneCLI gateway {{onecli_gateway}}, Dial agents {{dial_scope}}"; pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-secret.ts
```

## Attach the key to the chosen agents

NanoClaw gives every agent group its own OneCLI agent whose `identifier` is the
group id, created on the group's first spawn. For each agent group of this
install: a **chosen** group gets the Dial secret attached, and a chosen group
that has never spawned gets its OneCLI agent created now, holding the Dial key
(NanoClaw adds its model credential on its first spawn; if the group spawns
meanwhile, its agent is read back instead). Every other group has the Dial
secret detached first, so a failed attach never leaves an unchosen group holding
the key; this also re-narrows an upgraded install where the 1.44 conversion gave
the key to every agent. A group with no OneCLI agent is left without one. Attaching and detaching are idempotent and touch only this secret,
so each agent's other grants stay. Agents that are not this install's groups
(another install's, or OneCLI's default agent) are left alone. It runs even when an earlier step such as the image build failed, so
a replaced key is never left attached to nobody. The step prints `allowed:` or
`withheld:` per group:

```nc:run effect:external
A=$(printf '%s' '{{dial_scope}}' | tr -d ' '); S='{{dial_secret}}'; G=$(ncl groups list --json --limit 100000) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; AG=$(onecli agents list --max 0) || { echo "could not list OneCLI agents" >&2; exit 1; }; AG=$(printf '%s' "$AG" | jq -ce 'if type == "array" then . else .data end | arrays | if all(type == "object" and (.id | type) == "string" and .id != "" and (.identifier | type) == "string") then . else error("bad agent list") end') || { echo "could not read the OneCLI agent list" >&2; exit 1; }; printf '%s' "$G" | jq -e '(.data | type) == "array" and all(.data[]; (.id | type) == "string" and (.id | test("\\A[A-Za-z0-9_-]+\\z")))' >/dev/null || { echo "could not read the agent group list" >&2; exit 1; }; L=$(printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name | tostring | gsub("[\t\n\r]"; " "))"') || { echo "could not read the agent group list" >&2; exit 1; }; printf '%s\n' "$L" | while IFS="$(printf '\t')" read -r gid gname; do [ -n "$gid" ] || continue; case ",$A," in *,all,*|*,"$gid",*) ;; *) aid=$(printf '%s' "$AG" | jq -r --arg g "$gid" '.[] | select(.identifier==$g) | .id') || exit 1; if [ -n "$aid" ]; then onecli agents grants detach-secret --id "$aid" --secret-id "$S" >/dev/null || { echo "could not detach the Dial secret from $gname ($gid)" >&2; exit 1; }; fi; echo "withheld:$gid";; esac; done || exit 1; printf '%s\n' "$L" | while IFS="$(printf '\t')" read -r gid gname; do [ -n "$gid" ] || continue; case ",$A," in *,all,*|*,"$gid",*) aid=$(printf '%s' "$AG" | jq -r --arg g "$gid" '.[] | select(.identifier==$g) | .id') || exit 1; [ -n "$aid" ] || aid=$(onecli agents create --name "$gname" --identifier "$gid" 2>/dev/null | jq -r '.id // empty'); [ -n "$aid" ] || aid=$(onecli agents list --max 0 | jq -r --arg g "$gid" '(if type == "array" then . else .data end)[] | select(.identifier==$g) | .id'); [ -n "$aid" ] || { echo "could not create an OneCLI agent for $gname ($gid)" >&2; exit 1; }; onecli agents grants attach-secret --id "$aid" --secret-id "$S" >/dev/null || { echo "could not attach the Dial secret to $gname ($gid)" >&2; exit 1; }; echo "allowed:$gid";; esac; done
```

## Hand the tool to running agents

`container/skills/` is mounted read-only into every agent container, and each
group's `.claude-shared/skills/` holds symlinks into that mount that are synced
when the container spawns — so nothing is copied per session. A running agent
keeps its old image until it respawns, so restart every group; without a
`--message` each one comes back on its next message, on the new image, with the
CLI on `PATH` and the skill in place. This is a restart effect, so it does not
fire after an earlier step bounced — agents keep the image they have until the
gap above is fixed and the skill is re-applied:

```nc:run effect:restart
ncl groups list --json --limit 100000 | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid" >/dev/null || { echo "could not restart $gid" >&2; exit 1; }; done
```

## Done

The chosen agents can now use Dial from inside their containers; the others do
not hold the key. Auth is injected by OneCLI. Check the error code before the
status, which the gateway keeps from Dial (401, 403, or 400): `access_restricted`
means the agent does not hold the Dial key (it was not chosen, or was created
after the last run: run `/add-dial-tool` again to change that), and
`credential_not_found` or `app_not_connected` means no stored key matched the
request. A `401` with none of these codes comes from Dial and means the key is
stale.
Check which agents hold it with `onecli agents grants list --id <agent-id>`. Verify from a
chat with a chosen agent: "run dial doctor" or "text +1… hi".

To uninstall: see [REMOVE.md](REMOVE.md). To wire Dial as a **messaging
channel** too, run `/add-dial`.

## Troubleshooting

**`command -v onecli` fails.** OneCLI is not installed or not on `PATH`. Run
`/init-onecli`, then re-run this skill.

**The gateway version check stops.** The gateway is not on the pinned 1.45, or
an agent is still in `all` mode because the gateway's one-time grant conversion
has not finished. Follow `docs/onecli-upgrades.md`; do not attach the key by hand.

**`ncl` can't reach the host.** The agent list and the attach step talk to the
running NanoClaw service. Start it (`pnpm run dev`, or restart the service) and
re-run.

**`unknown agent group`.** An id in your answer is not in `ncl groups list`. Copy
the `ag-…` id exactly; names are not accepted.

**`no Dial API key in the host auth file`.** The sign-in did not complete. Run
`dial auth login <email> --force`, then `dial auth verify-otp --code <code>`, and
re-run.

**A chosen agent gets `401` or `access_restricted`.** Check the error code
first. `access_restricted` comes from the gateway, whatever the status: the
agent group was created after the last run, so it does not hold the key.
`credential_not_found` or `app_not_connected` means no stored key matched the
request. A `401` with none of these codes comes from Dial: the vault secret is
stale (a different account's key, or a rotated one). Re-run this skill: it
rewrites the secret with the key the host is signed in with and attaches it to
the agents you choose.

**An agent you left out can still use Dial.** It holds the key from before: an
agent that is not one of this install's groups (another install on the same
gateway, or OneCLI's default agent) is never touched. Detach it by hand with
`onecli agents grants detach-secret --id <agent-id> --secret-id <dial-secret-id>`.

**`dial: command not found` inside a container.** The image predates the manifest
entry. Run `./container/build.sh`, then `ncl groups restart --id <group-id>` so the
agent respawns on it.
