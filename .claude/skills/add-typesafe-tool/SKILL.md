---
name: add-typesafe-tool
description: Give NanoClaw agents TypeSafe's Jev decision model as a container tool — the `typesafe-judge` CLI (classify, route, rank, verify, yes/no with calibrated confidence) plus credential injection for api.typesafe.ai through the selected gateway (OneCLI or Iron Proxy). Use when agents should make judgments with a System One model instead of reasoning them out.
---

# Add TypeSafe Tool

Installs TypeSafe as a **container tool**: the `typesafe-judge` skill and CLI
mounted into every agent container, and a credential for `api.typesafe.ai`
held by the install's credential gateway so in-container calls are injected
at the network edge. The key never enters a container, an env var, or a chat.
Idempotent: safe to re-run.

The CLI is a Bun script shipped with the skill, so the agent image does not
change: no manifest entry, no rebuild. What lands on the host is the skill
directory under `container/skills/` and a guard test under `src/`.

Run this from the NanoClaw repo on the host (not from a chat with an agent; a
container cannot install itself).

## Pre-flight

Find which credential gateway this install uses. `NANOCLAW_GATEWAY_PROVIDER`
names it, exported in the environment first, then in `.env`, the same
precedence the host uses; an install that predates the setting is on OneCLI:

```nc:run capture:gateway validate:^[a-z][a-z0-9-]*$ effect:fetch
v="${NANOCLAW_GATEWAY_PROVIDER:-$(grep -E '^NANOCLAW_GATEWAY_PROVIDER=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')}"; printf '%s\n' "${v:-onecli}"
```

The gateway's CLI must be present, otherwise there is no way to hand the key
to a container without an env var. On OneCLI:

```nc:run effect:check when:gateway=onecli
command -v onecli >/dev/null
```

If it fails, tell the user to run `/init-onecli` first, then retry. On Iron
Proxy the bundled control helper must exist:

```nc:run effect:check when:gateway=iron-proxy
test -f .claude/skills/add-iron-proxy/scripts/control.ts
```

If it fails, `/add-iron-proxy` has not been applied on this checkout; apply it
first, then retry. Any other gateway is not covered by this skill: register the
credential for host `api.typesafe.ai` with header `Authorization` and value
`Bearer <key>` by that gateway's own means, then continue from
[Put the skill in the agent containers](#put-the-skill-in-the-agent-containers).

## Put the skill in the agent containers

`container/skills/` is mounted read-only into every agent container at
`/app/skills`, and each group's skill list is synced from it when the
container spawns. Copy the bundled skill there. The CLI, its unit tests, and
the question-design reference travel together so the installed copy is
testable in place:

```nc:copy
container-skills/typesafe-judge/SKILL.md -> container/skills/typesafe-judge/SKILL.md
container-skills/typesafe-judge/scripts/typesafe-judge.ts -> container/skills/typesafe-judge/scripts/typesafe-judge.ts
container-skills/typesafe-judge/scripts/typesafe-judge.test.ts -> container/skills/typesafe-judge/scripts/typesafe-judge.test.ts
container-skills/typesafe-judge/references/question-design.md -> container/skills/typesafe-judge/references/question-design.md
```

Copy the guard test into the host test tree. It asserts the installed skill is
complete and that its CLI still targets `api.typesafe.ai` with the placeholder
credential, which is what ties the container tool to the gateway rule below:

```nc:copy
typesafe-manifest.test.ts -> src/typesafe-manifest.test.ts
```

## Store the key in the gateway

The TypeSafe key is created in the TypeSafe console
(https://console.typesafe.ai, API keys). The operator stores it in the gateway
themselves; do not accept the key in chat, do not write it to a file inside the
repository, and do not pass it on a command line you run.

### OneCLI

Tell the user:

```nc:operator when:gateway=onecli
Store your TypeSafe API key in the OneCLI vault for host api.typesafe.ai. Either open this prefilled form in the OneCLI dashboard and paste the key there:

  http://127.0.0.1:10254/connections/secrets?create=generic&host=api.typesafe.ai&name=TypeSafe%20API%20Key&header=Authorization&format=Bearer%20%7Bvalue%7D

or, in a terminal on this host, run this one line (it prompts for the key without echo and never puts it on a command line or in shell history):

  umask 077 && printf 'TypeSafe API key: ' && read -rs k && echo && printf '%s' "$k" > "$HOME/.typesafe-key" && unset k && onecli secrets create --name "TypeSafe API Key" --type generic --host-pattern api.typesafe.ai --header-name Authorization --value-format "Bearer {value}" --file "$HOME/.typesafe-key"; rm -f "$HOME/.typesafe-key"

Tell me when the secret exists.
```

Then confirm the vault has a secret for that exact host (the name is not
consulted, so an unrelated "TypeSafe" secret for another host cannot pass).
A missing secret stops here; nothing later can work without it:

```nc:run effect:check when:gateway=onecli
onecli secrets list | jq -e '.data[] | select(.hostPattern=="api.typesafe.ai")' >/dev/null
```

Agents in `all` secret mode (the NanoClaw default) get the secret automatically.
An agent in `selective` mode only gets what is on its list, so merge the secret
into every selective agent's list. `set-secrets` is never called on an
`all`-mode agent because it would switch that agent to selective and cut it
off from its other secrets:

```nc:run effect:wire when:gateway=onecli
S=$(onecli secrets list | jq -r 'first(.data[] | select(.hostPattern=="api.typesafe.ai")) | .id // empty'); [ -n "$S" ] || { echo "no api.typesafe.ai secret in the OneCLI vault — the credential step above did not complete" >&2; exit 1; }; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; printf '%s' "$AG" | jq -r '.data[] | select(.secretMode=="selective") | "\(.id)\t\(.identifier)"' | while IFS="$(printf '\t')" read -r aid gid; do CUR=$(onecli agents secrets --id "$aid") || { echo "could not read the secret list of $gid; leaving it untouched" >&2; exit 1; }; MERGED=$(printf '%s' "$CUR" | jq -er --arg s "$S" '[.data[], $s] | unique | join(",")') || { echo "unexpected secret list for $gid; leaving it untouched" >&2; exit 1; }; onecli agents set-secrets --id "$aid" --secret-ids "$MERGED" >/dev/null || { echo "could not add the TypeSafe secret to $gid" >&2; exit 1; }; echo "TypeSafe secret added to the list of $gid"; done
```

Put a spend ceiling in the gateway. The CLI caps a single call at 64
questions, but only the gateway can cap what a looping or scheduled agent
spends over time. One rate-limit rule, with no agent scope, applies to every
agent; OneCLI counts it **per agent**, so it is a ceiling on each agent, not a
shared budget for the host. 600 requests an hour per agent is far above
interactive use and low enough to stop a runaway; change the number in the
OneCLI dashboard to suit the plan.

The rule is matched by its exact name so only this skill's rule is ever read
or written. An existing rule with that name must actually be the ceiling
(right host, `rate_limit`, enabled, no agent scope); anything else stops here
rather than passing as protection:

```nc:run effect:wire when:gateway=onecli
RL=$(onecli rules list) || { echo "could not list OneCLI rules" >&2; exit 1; }; printf '%s' "$RL" | jq -e '.data | type == "array"' >/dev/null || { echo "unexpected output from onecli rules list; not creating anything" >&2; exit 1; }; N=$(printf '%s' "$RL" | jq '[.data[] | select(.name=="TypeSafe: spend ceiling")] | length'); if [ "$N" -eq 0 ]; then onecli rules create --name "TypeSafe: spend ceiling" --host-pattern api.typesafe.ai --action rate_limit --rate-limit 600 --rate-limit-window hour --enabled >/dev/null || { echo "could not create the TypeSafe rate-limit rule" >&2; exit 1; }; else printf '%s' "$RL" | jq -e '[.data[] | select(.name=="TypeSafe: spend ceiling")] | length == 1 and (.[0].hostPattern=="api.typesafe.ai") and (.[0].action=="rate_limit") and (.[0].enabled==true) and ((.[0].agentId // "")=="") and ((.[0].rateLimit // 0) > 0)' >/dev/null || { echo "a rule named \"TypeSafe: spend ceiling\" exists but is not an enabled, unscoped rate limit on api.typesafe.ai — fix or delete it in the OneCLI dashboard, then re-run" >&2; exit 1; }; fi
```

An agent that hits the ceiling gets a 429 from the gateway; the CLI turns a
rate limit that will not clear within its patience into exit code 5, which
tells the agent to stop the loop it is in.

### Iron Proxy

Tell the user:

```nc:operator when:gateway=iron-proxy
Store your TypeSafe API key in Iron Control (the URL and login file printed by /add-iron-proxy; `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/control.ts status` prints them again). Under Secrets create a static secret named "TypeSafe API Key" with rule host api.typesafe.ai, all methods, inject header Authorization with formatter "Bearer {{ .Value }}". Note the secret id, then in a terminal on this host run:

  pnpm exec tsx .claude/skills/add-iron-proxy/scripts/control.ts grant static <secret-id>
  pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --allow-host api.typesafe.ai

Tell me when both commands have succeeded.
```

Iron holds the grant and the egress allowance; there is nothing further to
wire on the NanoClaw side. Requests to `api.typesafe.ai` go through that
gateway's approval flow. The endpoint is a POST, so the read-only-hosts
exemption does not apply: approve the first card, or add a policy for the host
in Iron Control.

## Verify

Run the guard test and the CLI's own unit tests. The unit tests mock the HTTP
layer, so they need no key and no network:

```nc:run effect:test
pnpm exec vitest run src/typesafe-manifest.test.ts
cd container/skills/typesafe-judge && bun test
```

## Hand the tool to running agents

A running agent keeps the skill list it was spawned with. Restart every group
so each comes back on its next message with `typesafe-judge` in place. This is a
restart effect, so it does not fire after an earlier step bounced:

```nc:run effect:restart
G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid" >/dev/null || { echo "could not restart $gid" >&2; exit 1; }; done
```

## Done

Every agent can now run `bun /app/skills/typesafe-judge/scripts/typesafe-judge.ts`
(the container skill tells it when and how). Auth is injected by the gateway;
exit code 2 from the CLI means the gateway or TypeSafe refused the call (a 401
is a missing credential, a 403 is a policy, quota or permission) and exit code
5 means rate limited; neither is a bug. Verify from a chat with any agent:

> Using typesafe-judge, ask one noul question: is "the container never starts" a bug report? Show the raw answer.

Background and behavior: [docs/typesafe-judge.md](../../../docs/typesafe-judge.md).
To uninstall: see [REMOVE.md](REMOVE.md).

## Troubleshooting

**`command -v onecli` fails.** OneCLI is not installed or not on `PATH`. Run
`/init-onecli`, then re-run this skill.

**The vault check fails after the operator stored the key.** The secret's host
pattern must be exactly `api.typesafe.ai` (no scheme, no path); the check
matches on the host, not the name. `onecli secrets list` shows what is stored.

**An agent gets exit code 2 with a 401.** The gateway has no credential for
`api.typesafe.ai`, or the agent is in `selective` mode without the secret on
its list. Re-run this skill; the wire step merges the secret into every
selective agent.

**An agent gets exit code 2 with a 403.** The credential is probably fine. A
gateway block rule scoped to that agent refused the call, or the key is out of
quota or lacks permission. Check `onecli rules list`, then the TypeSafe
console.

**An agent gets exit code 5.** Rate limited: the per-agent "TypeSafe: spend
ceiling" rule, or the TypeSafe plan's own limit. The agent should have stopped
its loop. Raise the rule's number in the OneCLI dashboard if the workload is
legitimate.

**An agent gets exit code 3 (`could not reach TypeSafe`).** The container's
`HTTPS_PROXY` is not reaching the gateway, or the gateway is blocking the host.
Check the gateway's logs and, on Iron Proxy, that `api.typesafe.ai` is in the
allowed hosts.

**`bun: command not found` inside a container.** The image predates the Bun
runtime; rebuild with `./container/build.sh` and restart the group.

**`ncl` can't reach the host.** The restart step talks to the running NanoClaw
service. Start it and re-run.
