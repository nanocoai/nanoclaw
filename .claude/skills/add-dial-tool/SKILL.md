---
name: add-dial-tool
description: Give chosen NanoClaw agents a real phone number as a container tool — the `dial` CLI baked into the agent image plus OneCLI credential injection for api.getdial.ai, scoped per agent, so the agents you pick can send SMS, place AI voice calls, and receive verification codes from inside the sandbox. Independent of the Dial channel; idempotent; re-run to change which agents may use it. Use when the user wants agents to text, call, or run `dial …` from a chat, without wiring Dial as a messaging channel.
---

# Add Dial Tool

Installs Dial as a **container tool**: the `dial` CLI on the agent's `PATH`, the
`dial-cli` skill so the agent knows how to drive it, an OneCLI credential so
in-container calls are injected keyless, and an OneCLI policy that names which
agents may reach Dial. Independent of the Dial **channel**
(`/add-dial`) — install this alone. Idempotent: re-run it to change which agents
may use Dial.

**This tool spends money and reaches real people.** An agent with Dial access can
text and call any number and buy more numbers, billed to the Dial account. The
CLI and the skill file land in every agent's container, but the **key** is
injected per agent by OneCLI, so the operator chooses which agents get it. Every
other agent is blocked by an OneCLI policy rule and sees `403 blocked_by_policy`
if it tries.

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

This skill scopes Dial through the OneCLI policy API, which gateway 1.42 (the
version NanoClaw pins) enforces. Older gateways do not enforce it, and 1.43 and
later remove the agent secret-assignment command (`onecli agents set-secrets`)
the selective-agent step still uses. Writing the Dial key first and then failing
on the policy would leave every `all`-mode agent able to use Dial. So read the
version of the gateway the `onecli` CLI talks to before anything is written, and
stop unless it is 1.42. The Dial sign-up and credential steps below use the
captured version, so they cannot run when this check fails:

```nc:run capture:onecli_gateway validate:^[0-9]+\.[0-9]+\.[0-9]+$ effect:fetch
U=$(onecli config get api-host | jq -r '.value // empty') && [ -n "$U" ] || { echo "could not read the onecli CLI's api-host, so the OneCLI gateway version cannot be checked. Nothing was written to OneCLI." >&2; exit 1; }; H=$(curl -fsS --max-time 10 "$U/api/health") || { echo "could not reach the OneCLI gateway at $U. Nothing was written to OneCLI." >&2; exit 1; }; V=$(printf '%s' "$H" | jq -er '.version') || V=; case "$V" in 1.42.[0-9]|1.42.[0-9][0-9]*) echo "$V"; exit 0;; 0.*|1.[0-9].*|1.[1-3][0-9].*|1.4[01].*) W="is older than 1.42 and does not enforce the OneCLI policy API this skill uses";; *) W="is newer than 1.42; OneCLI 1.43 and later remove the agent secret-assignment command (onecli agents set-secrets) this skill still uses";; esac; echo "OneCLI gateway version '${V:-unreadable}' at $U $W. Nothing was written to OneCLI. /add-dial-tool supports the pinned gateway, 1.42.0: see docs/onecli-upgrades.md to move the gateway to it." >&2; exit 1
```

If it fails, show the user the message as it is and stop. Do not work around it
by turning off OneCLI policy enforcement or granting the Dial key by hand: the
policy is what keeps agents you did not choose away from Dial.

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
must be a real agent group. The checked answer is captured, and every step that
installs, signs in, or writes a credential below depends on the capture: a bad
answer stops them all, nothing is written:

```nc:run capture:dial_scope validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ effect:fetch
A=$(printf '%s' '{{dial_agents}}' | tr -d ' '); G=$(ncl groups list --json --limit 100000) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; for w in $(printf '%s' "$A" | tr ',' ' '); do case "$w" in all|none) ;; *) printf '%s' "$G" | jq -e --arg id "$w" '.data[] | select(.id==$id)' >/dev/null || { echo "unknown agent group '$w' — see: ncl groups list" >&2; exit 1; }; esac; done; printf '%s\n' "$A"
```

## Scope it to the chosen agents

### Create the OneCLI agents

NanoClaw gives every agent group its own OneCLI agent whose `identifier` is the
group id, created on the group's first spawn. A group that has never spawned has
no OneCLI agent yet, and the policy names agents, not groups — so create the
missing ones now, exactly as the runtime would (secret mode `all`, nothing else
touched):

```nc:run effect:wire
G=$(ncl groups list --json --limit 100000) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do printf '%s' "$AG" | jq -e --arg g "$gid" '.data[] | select(.identifier==$g)' >/dev/null || onecli agents create --name "$gname" --identifier "$gid" >/dev/null || { echo "could not create an OneCLI agent for $gname ($gid)" >&2; exit 1; }; done
```

### Set the policy

The one switch is an OneCLI **policy rule**, `Dial: blocked agents`, a block on
`api.getdial.ai` whose identities are every agent you did not choose, kept by
[scripts/dial-policy.ts](scripts/dial-policy.ts). It is a block and not an
allow on purpose: OneCLI drops a deleted agent from a rule's identities, and a
block left with none blocks every agent, where an allow left with none would
open Dial to every agent. `all` means no rule at all. The pinned `onecli` CLI has
no policy commands, so the script calls the policy API of the gateway the CLI is
configured for, with the CLI's own key. On every run it creates the rule anew,
moves it to the top of the order, deletes the earlier one and any `Dial:
blocked for <group>` rule a legacy block was migrated to, publishes the policy,
and reads the published generation back. The block sits first, so under
first-match no operator allow can let a blocked agent through; the operator's
own rules keep their relative order and are otherwise left alone. Agents another NanoClaw install on the same
gateway blocked stay blocked. Publishing applies the whole policy draft, so
finish or discard any edit left open in the OneCLI console first. The
policy lands before any Dial sign-in or key write, and the credential step
below depends on this capture, so the key can never exist without the block.
The capture is ids and the word `published` only (names stay on stderr), since
it is interpolated into that step. If this step fails, show the message and
stop; do not write the Dial key by hand. A `403 blocked_by_policy` in a
container means "not chosen", not "broken":

```nc:run capture:dial_policy validate:^((allowed|blocked):ag-[A-Za-z0-9-]+\n)*published$ effect:wire
pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents {{dial_scope}}
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
This host is signed in to Dial as {{connected_email}}; the agents you chose will use that account. To give them a different account, run `dial auth login <email> --force` and `dial auth verify-otp --code <code>` on the host first, then run /add-dial-tool again.
```

### Send the code

If it is **not**, verify an email with a one-time code. Collect the email:

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
by `dial auth login` / `dial auth verify-otp` — and put it in the OneCLI vault
for `api.getdial.ai`. Always **replace**: the vault is keyed by name, so an
existing "Dial API" secret is not necessarily this account's (re-onboarding,
switching accounts, or rotating the key all leave a secret whose value points at
the previous account, and a sandboxed agent then lists *that* account's numbers).
A stale secret is deleted and a fresh one created rather than updated in place:
`onecli secrets update` accepts a new value only on the command line, and the key
must never sit on one. It travels through a `0600` temp file that is removed right
after (`--file`), so it is never on argv or in a captured variable. The step
depends on the policy capture above, so the key is only written once the block
is published. Selective-mode agents pick the new id up in the merge step below:

```nc:run effect:external
: "OneCLI gateway {{onecli_gateway}}, Dial agents {{dial_scope}}, policy {{dial_policy}}"; T=$(mktemp) && chmod 600 "$T" && jq -r '.apiKey // empty' "${XDG_DATA_HOME:-$HOME/.local/share}/dial/auth.v1.json" > "$T" 2>/dev/null; [ -s "$T" ] || { rm -f "$T"; echo "no Dial API key in the host auth file — sign in with dial auth login / verify-otp, then re-run" >&2; exit 1; }; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name | test("(?i)dial"))) | .id // empty'); if [ -n "$S" ]; then onecli secrets delete --id "$S" >/dev/null || { rm -f "$T"; echo "could not remove the previous Dial secret $S" >&2; exit 1; }; fi; onecli secrets create --name "Dial API" --type generic --file "$T" --host-pattern api.getdial.ai --header-name Authorization --value-format "Bearer {value}" >/dev/null; rc=$?; rm -f "$T"; exit $rc
```

## Merge secrets for selective agents

Secret lists are left alone, with one exception. An agent in `selective` mode only
gets the secrets on its list, so a **chosen** selective agent has the Dial secret
merged into it. `onecli agents set-secrets` switches an agent to selective mode,
so it is never called on an `all`-mode agent — that would silently cut the agent
off from every credential not on its list. Blocked agents keep their lists
untouched in either mode; the policy alone blocks:

```nc:run effect:wire
A=$(printf '%s' '{{dial_scope}}' | tr -d ' '); case ",$A," in *,all,*) A=$(ncl groups list --json --limit 100000 | jq -r '[.data[].id] | join(",")');; esac; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name | test("(?i)dial"))) | .id // empty'); [ -n "$S" ] || { echo "no Dial secret in the OneCLI vault — the credential step above did not complete" >&2; exit 1; }; onecli agents list | jq -r '.data[] | select(.secretMode=="selective") | "\(.id)\t\(.identifier)"' | while IFS="$(printf '\t')" read -r aid gid; do case ",$A," in *,"$gid",*) onecli agents set-secrets --id "$aid" --secret-ids "$(onecli agents secrets --id "$aid" | jq -r --arg s "$S" '[.data[], $s] | unique | join(",")')" >/dev/null || { echo "could not add the Dial secret to $gid" >&2; exit 1; }; echo "Dial secret added to the list of $gid";; esac; done
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

The chosen agents can now use Dial from inside their containers; the others are
blocked at the gateway. Auth is injected by OneCLI; a `403 blocked_by_policy`
means the agent was not chosen (run `/add-dial-tool` again to change that); a
`401` means the Dial secret needs (re)connecting — not a login. The policy is
visible in the OneCLI console under Policy (`Dial: blocked agents`). Verify from a
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
(a new OneCLI agent starts in `all` mode and is not in the block). Re-run this
skill; it only touches its own policy rule.

**`no published policy yet`.** The gateway's 1.42 migration of this project did
not publish a policy, so it still runs on legacy rules; publishing now would
pre-empt that migration. Check the gateway log for `policy-oss-cutover`.

**A blocked agent still reaches Dial on gateway 1.42.** Two causes. A rule was
moved above `Dial: blocked agents` in the OneCLI console: re-run this skill,
which moves the block back to the top. Or the gateway runs with the operator
kill switch `POLICY_ENFORCE_V2=0` in its environment, which makes it ignore the
published policy; nothing in the API shows it. Check the gateway's compose
environment and unset it.

**`dial: command not found` inside a container.** The image predates the manifest
entry. Run `./container/build.sh`, then `ncl groups restart --id <group-id>` so the
agent respawns on it.
