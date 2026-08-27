---
name: add-dial-tool
description: Give chosen NanoClaw agents a real phone number as a container tool — the `dial` CLI baked into the agent image plus OneCLI credential injection for api.getdial.ai, scoped per agent, so the agents you pick can send SMS, place AI voice calls, and receive verification codes from inside the sandbox. Independent of the Dial channel; idempotent; re-run to change which agents may use it. Use when the user wants agents to text, call, or run `dial …` from a chat, without wiring Dial as a messaging channel.
---

# Add Dial Tool

Installs Dial as a **container tool**: the `dial` CLI on the agent's `PATH`, the
`dial-cli` skill so the agent knows how to drive it, and an OneCLI credential so
in-container calls are injected keyless. Independent of the Dial **channel**
(`/add-dial`) — install this alone. Idempotent: re-run it to change which agents
may use Dial.

**This tool spends money and reaches real people.** An agent with Dial access can
text and call any number and buy more numbers, billed to the Dial account. The
CLI and the skill file land in every agent's container, but the **key** is
injected per agent by OneCLI, so the operator chooses which agents get it. Every
other agent gets an OneCLI block rule and sees `403 blocked_by_policy` if it
tries.

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
Agents on this install: {{agent_groups}}. Giving an agent Dial lets it text and call any number and buy numbers, billed to your Dial account. Agents you leave out are blocked at the gateway (reversible by running /add-dial-tool again). Agents created after this run have Dial until the next run.
```
```nc:prompt dial_agents validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ normalize:trim
Which agents may use Dial? Enter agent ids separated by commas with no spaces (the `ag-…` column), `all` for every agent, or `none` to install the tool with every agent blocked for now.
```

`all` and `none` cannot be mixed with ids, and an empty answer is never
"everyone". A typo must not silently open or close anything, so every id named
must be a real agent group:

```nc:run effect:check
for w in $(printf '%s' '{{dial_agents}}' | tr ',' ' '); do case "$w" in all|none) ;; *) ncl groups list --json | jq -e --arg id "$w" '.data[] | select(.id==$id)' >/dev/null || { echo "unknown agent group '$w' — see: ncl groups list" >&2; exit 1; }; esac; done
```

## Install the Dial CLI on the host

The host needs the `dial` CLI to sign in: `dial auth login` / `dial auth
verify-otp` write the host auth file that the credential step below reads. Pinned
to the same version the agent image gets, so host and sandbox agree:

```nc:run effect:external
command -v dial >/dev/null || npm install -g @getdial/cli@0.37.0
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
This host is signed in to Dial as {{connected_email}}; the agents you chose will use that account. To give them a different account, run `dial auth login <email> --force` and `dial auth verify-otp --code <code>` on the host first, then run /add-dial-tool again.
```

### Send the code

If it is **not**, verify an email with a one-time code. Collect the email:

```nc:prompt owner_email validate:^[^@\s]+@[^@\s]+\.[^@\s]+$ when:signed_in=false
What's your email? Dial sends a one-time code to verify it. By continuing you create a Dial account and agree to Dial's Terms of Service (https://getdial.ai/terms) and Privacy Policy (https://getdial.ai/privacy).
```

Send the code (`--force` re-sends even if a prior code is pending):

```nc:run effect:external when:signed_in=false
DIAL_USER_AGENT={{dial_ua}} dial auth login {{owner_email}} --force
```

### Verify the code

Collect the code:

```nc:prompt otp validate:^\d{6}$ when:signed_in=false
Enter the 6-digit code from your email
```

Verify it. Do **not** pass `--agent nanoclaw` here: this skill owns the container
`dial-cli` skill, and `--agent` would drop a second, unmanaged copy next to it:

```nc:run effect:external when:signed_in=false
DIAL_USER_AGENT={{dial_ua}} dial auth verify-otp --code {{otp}}
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
by `dial auth login` / `dial auth verify-otp` — and put it in the OneCLI vault
for `api.getdial.ai`. Always **replace**: the vault is keyed by name, so an
existing "Dial API" secret is not necessarily this account's (re-onboarding,
switching accounts, or rotating the key all leave a secret whose value points at
the previous account, and a sandboxed agent then lists *that* account's numbers).
A stale secret is deleted and a fresh one created rather than updated in place:
`onecli secrets update` accepts a new value only on the command line, and the key
must never sit on one. It travels through a `0600` temp file that is removed right
after (`--file`), so it is never on argv or in a captured variable. Selective-mode
agents pick the new id up in the merge step below:

```nc:run effect:external
T=$(mktemp) && chmod 600 "$T" && jq -r '.apiKey // empty' "${XDG_DATA_HOME:-$HOME/.local/share}/dial/auth.v1.json" > "$T" 2>/dev/null; [ -s "$T" ] || { rm -f "$T"; echo "no Dial API key in the host auth file — sign in with dial auth login / verify-otp, then re-run" >&2; exit 1; }; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name | test("(?i)dial"))) | .id // empty'); if [ -n "$S" ]; then onecli secrets delete --id "$S" >/dev/null || { rm -f "$T"; echo "could not remove the previous Dial secret $S" >&2; exit 1; }; fi; onecli secrets create --name "Dial API" --type generic --file "$T" --host-pattern api.getdial.ai --header-name Authorization --value-format "Bearer {value}" >/dev/null; rc=$?; rm -f "$T"; exit $rc
```

## Scope it to the chosen agents

### Create the OneCLI agents

NanoClaw gives every agent group its own OneCLI agent whose `identifier` is the
group id, created on the group's first spawn. A group that has never spawned has
no OneCLI agent yet, and a block rule needs one to attach to — so create the
missing ones now, exactly as the runtime would (secret mode `all`, nothing else
touched):

```nc:run effect:wire
G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do printf '%s' "$AG" | jq -e --arg g "$gid" '.data[] | select(.identifier==$g)' >/dev/null || onecli agents create --name "$gname" --identifier "$gid" >/dev/null || { echo "could not create an OneCLI agent for $gname ($gid)" >&2; exit 1; }; done
```

### Set the block rules

The one switch is a per-agent **block rule** on `api.getdial.ai`, named
`Dial: blocked for <group>` so only this skill's rules are ever read or written
(an operator's own rules on the host are left alone). A chosen agent has its
rule removed; every other agent has one present and enabled. A `403
blocked_by_policy` in a container means "not chosen", not "broken":

```nc:run effect:wire
A=$(printf '%s' '{{dial_agents}}' | tr -d ' '); G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; case ",$A," in *,all,*) A=$(printf '%s' "$G" | jq -r '[.data[].id] | join(",")');; esac; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; RL=$(onecli rules list) || { echo "could not list OneCLI rules" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do aid=$(printf '%s' "$AG" | jq -r --arg g "$gid" 'first(.data[] | select(.identifier==$g)) | .id // empty'); [ -n "$aid" ] || { echo "no OneCLI agent for $gname ($gid)" >&2; exit 1; }; rid=$(printf '%s' "$RL" | jq -r --arg a "$aid" 'first(.data[] | select(.hostPattern=="api.getdial.ai" and .action=="block" and .agentId==$a and (.name | startswith("Dial: blocked for ")) and ((.pathPattern // "")=="") and ((.method // "")==""))) | .id // empty'); case ",$A," in *,"$gid",*) if [ -n "$rid" ]; then onecli rules delete --id "$rid" >/dev/null || { echo "could not remove the Dial block for $gname ($gid)" >&2; exit 1; }; fi; echo "allowed: $gname ($gid)";; *) if [ -z "$rid" ]; then onecli rules create --name "Dial: blocked for $gname" --host-pattern api.getdial.ai --action block --agent-id "$aid" --enabled >/dev/null || { echo "could not create the Dial block for $gname ($gid)" >&2; exit 1; }; else onecli rules update --id "$rid" --enabled true >/dev/null || { echo "could not re-enable the Dial block for $gname ($gid)" >&2; exit 1; }; fi; echo "blocked: $gname ($gid)";; esac; done
```

### Merge secrets for selective agents

Secret lists are left alone, with one exception. An agent in `selective` mode only
gets the secrets on its list, so a **chosen** selective agent has the Dial secret
merged into it. `onecli agents set-secrets` switches an agent to selective mode,
so it is never called on an `all`-mode agent — that would silently cut the agent
off from every credential not on its list. Blocked agents keep their lists
untouched in either mode; the rule alone blocks:

```nc:run effect:wire
A=$(printf '%s' '{{dial_agents}}' | tr -d ' '); case ",$A," in *,all,*) A=$(ncl groups list --json | jq -r '[.data[].id] | join(",")');; esac; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name | test("(?i)dial"))) | .id // empty'); [ -n "$S" ] || { echo "no Dial secret in the OneCLI vault — the credential step above did not complete" >&2; exit 1; }; onecli agents list | jq -r '.data[] | select(.secretMode=="selective") | "\(.id)\t\(.identifier)"' | while IFS="$(printf '\t')" read -r aid gid; do case ",$A," in *,"$gid",*) onecli agents set-secrets --id "$aid" --secret-ids "$(onecli agents secrets --id "$aid" | jq -r --arg s "$S" '[.data[], $s] | unique | join(",")')" >/dev/null || { echo "could not add the Dial secret to $gid" >&2; exit 1; }; echo "Dial secret added to the list of $gid";; esac; done
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
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid" >/dev/null || { echo "could not restart $gid" >&2; exit 1; }; done
```

## Done

The chosen agents can now use Dial from inside their containers; the others are
blocked at the gateway. Auth is injected by OneCLI; a `403 blocked_by_policy`
means the agent was not chosen (run `/add-dial-tool` again to change that); a
`401` means the Dial secret needs (re)connecting — not a login. Verify from a
chat with a chosen agent: "run dial doctor" or "text +1… hi".

To uninstall: see [REMOVE.md](REMOVE.md). To wire Dial as a **messaging
channel** too, run `/add-dial`.

## Troubleshooting

**`command -v onecli` fails.** OneCLI is not installed or not on `PATH`. Run
`/init-onecli`, then re-run this skill.

**`ncl` can't reach the host.** The agent list and the scoping steps talk to the
running NanoClaw service. Start it (`pnpm run dev`, or restart the service) and
re-run.

**`unknown agent group`.** An id in your answer is not in `ncl groups list`. Copy
the `ag-…` id exactly; names are not accepted.

**`no Dial API key in the host auth file`.** The sign-in did not complete. Run
`dial auth login <email> --force`, then `dial auth verify-otp --code <code>`, and
re-run.

**A chosen agent gets `401`.** The vault secret is stale (a different account's
key, or a rotated one). Re-run this skill — it always rewrites the secret with the
key the host is signed in with.

**An agent you left out can still use Dial.** It was created after the last run
(a new OneCLI agent starts in `all` mode with no rule). Re-run this skill; it
only touches the per-agent rules.

**`dial: command not found` inside a container.** The image predates the manifest
entry. Run `./container/build.sh`, then `ncl groups restart --id <group-id>` so the
agent respawns on it.
