---
name: add-gpt-live
description: Add the GPT-Live channel — OpenAI's full-duplex voice model (gpt-live-1) as the mouth and ears of a browser call, with the NanoClaw agent as the brain. Native adapter, client-delegation mode, no Chat SDK bridge, no new package. Use when the user wants to talk to an agent by voice, give an agent a phone presence, or try GPT-Live-1 with NanoClaw.
---

# Add GPT-Live Channel

Adds [GPT-Live-1](https://developers.openai.com/api/docs/guides/live) as a
voice channel. The voice model handles listening and speaking in real time;
every turn that needs facts, memory, tools or an action is delegated to a
NanoClaw session, whose reply is spoken back. Native adapter: the host creates
the live session, attaches a server-side sideband WebSocket, and maps
delegations to inbound messages and agent replies to spoken commentary.
NanoClaw doesn't ship channels in trunk — this skill copies the adapter and its
tests in from the `channels` branch.

A **voice line** is one call link, `…/webhook/gpt-live/call?t=<token>`, wired to
one agent group. Every call on the link lands in the same agent session, so the
agent remembers the previous call. Inside NanoClaw the line goes by a *line id*,
a hash of the token, so the token itself stays in the link and never reaches the
database, the logs or the agent. This skill sets up one line for a browser.
Phone calls over SIP are a later step.

Costs money: OpenAI bills voice sessions at $0.05 per minute, per second, plus
the agent's own model usage. The link token is the only thing between the
internet and that bill — treat the link like a password.

## Apply

### 1. Copy the adapter and tests

Fetch the `channels` branch and copy the adapter, its session state machine,
the voice prompt composer, the call page, and their tests into place
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/gpt-live.ts
src/channels/gpt-live-session.ts
src/channels/gpt-live-prompt.ts
src/channels/gpt-live-call-page.ts
src/channels/gpt-live-keychain.ts
src/channels/gpt-live-sideband.ts
src/channels/gpt-live-session.test.ts
src/channels/gpt-live-adapter.test.ts
src/channels/gpt-live-keychain.test.ts
src/channels/gpt-live-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if present).
This one line is the skill's only reach-in into the channel core:

```nc:append to:src/channels/index.ts
import './gpt-live.js';
```

### 3. Teach agents to write for the ear

Replies on this channel are spoken. Mount the formatting skill so every agent
answers a call in short plain prose. `container/skills/` is mounted read-only
into every agent container; the skill only changes behaviour when a message
arrives from the `gpt-live` channel:

```nc:copy
container-skills/gpt-live-formatting/SKILL.md -> container/skills/gpt-live-formatting/SKILL.md
```

### 4. Build

No new package: the adapter uses Node's built-in `fetch` and WebSocket client
(Node 22 or later, which NanoClaw already requires). Build first: it guards the
adapter's typed calls into the channel core.

```nc:run effect:build
pnpm run build
```

### 5. Validate

Run the registration test, the session state-machine tests, and the adapter
integration test (a fake OpenAI behind the real webhook server):

```nc:run effect:test
pnpm exec vitest run src/channels/gpt-live-registration.test.ts src/channels/gpt-live-session.test.ts src/channels/gpt-live-adapter.test.ts src/channels/gpt-live-keychain.test.ts
```

`gpt-live-registration.test.ts` imports the real channel barrel and asserts the
registry contains `gpt-live` — it goes red if the import line drifts.
`gpt-live-session.test.ts` covers the delegation bookkeeping (transcript cut,
chunking, barge-in). `gpt-live-adapter.test.ts` drives the call page and SDP
routes over HTTP, checks the session is created in client-delegation mode with
the wired agent's name, and round-trips a delegation to an inbound message and
a reply to spoken commentary over the sideband. A real call is verified
manually once the service runs.

## Connect to OpenAI

### API key

The adapter needs an OpenAI API key with access to `gpt-live-1`. It is read on
the host only; the agent container never sees it. Two places it can live:
pasted into `.env`, or (macOS) in your login Keychain, where `.env` only names
the item and the host reads it at startup with the system `security` tool.

```nc:prompt key_source validate:^(paste|keychain)$ normalize:lower
Where should the OpenAI key live? "paste" writes it to .env; "keychain" (macOS) keeps it in your login Keychain and .env only names the item. (paste/keychain)
```

**Paste** — collected as a secret and written to `.env`:

```nc:prompt openai_api_key secret validate:^sk-.{20,}$ normalize:trim when:key_source=paste
Paste an OpenAI API key with access to gpt-live-1 (starts with sk-). Create one at https://platform.openai.com/api-keys
```
```nc:env-set when:key_source=paste
OPENAI_API_KEY={{openai_api_key}}
```

**Keychain** — the user adds the item in their own terminal, so the key never
passes through this setup or their shell history. The shell reads the key
with `read -s` rather than `security`'s own hidden prompt, which silently cuts
input at 128 characters (project keys are longer); `-T` lets the `security`
tool read the item back without a dialog. Tell the user:

```nc:operator when:key_source=keychain
Run this in a terminal; when it says "Paste the OpenAI key", paste it (nothing is echoed) and press Enter: printf 'Paste the OpenAI key, then press Enter: '; read -s KEY; echo; security add-generic-password -U -s nanoclaw-openai -a "$USER" -T /usr/bin/security -w "$KEY"; unset KEY
```
```nc:env-set when:key_source=keychain
GPT_LIVE_KEYCHAIN_SERVICE=nanoclaw-openai
```

Check the item reads back before going on (the value goes nowhere):

```nc:run effect:check when:key_source=keychain
security find-generic-password -s nanoclaw-openai -a "$USER" -w >/dev/null
```

### Public URL

The call page and the SDP handshake are served by the host's webhook server.
Give the origin a caller's browser reaches it at — `http://localhost:3000` for
a local try, a tailnet or tunnel URL to call from a phone's browser. Browsers
allow the microphone only on `localhost` or HTTPS. Set-if-absent, so a re-run
keeps your value:

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What origin can a caller's browser reach this NanoClaw host at? (e.g. http://localhost:3000 or https://nanoclaw.example.ts.net)
```
```nc:env-set
GPT_LIVE_PUBLIC_URL={{public_url}}
GPT_LIVE_VOICE=marin
```

### Link token

The voice line's secret. Reuse the one already in `.env` on a re-run, otherwise
mint a fresh one:

```nc:run capture:link_token validate:^[0-9a-f]{16}$ effect:fetch
grep -s '^GPT_LIVE_LINK_TOKEN=' .env | cut -d= -f2- | cut -d, -f1 | grep -E '^[0-9a-f]{16}$' || openssl rand -hex 8
```
```nc:env-set
GPT_LIVE_LINK_TOKEN={{link_token}}
```

The line id is what NanoClaw calls this link (`gpt-live:<line id>`): the first
twelve hex characters of the token's SHA-256, derived the same way the adapter
derives it, so the token itself is never written anywhere but `.env`:

```nc:run capture:line_id validate:^[0-9a-f]{12}$ effect:fetch
printf '%s' '{{link_token}}' | node -e "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>console.log(require('crypto').createHash('sha256').update(d).digest('hex').slice(0,12)))"
```

## Choose the agent

The line is wired to one agent group. List them (the NanoClaw service must be
running — `ncl` talks to it over its socket):

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet — run /init-first-agent first" else [.data[] | "\(.folder) (\(.name))"] | join(", ") end'
```
```nc:operator
Agent groups on this install: {{agent_groups}}. The voice line is wired to one of them; the voice model introduces itself with that agent's name and hands it every question that needs memory or tools.
```
```nc:prompt agent_folder validate:^[A-Za-z0-9_-]+$ normalize:trim
Which agent group answers the voice line? Enter its folder name (the first column above).
```

The folder must be a real agent group — a typo must not wire the line to
nothing:

```nc:run effect:check
ncl groups list --json | jq -e --arg f '{{agent_folder}}' '.data[] | select(.folder==$f)' >/dev/null || { echo "unknown agent group folder '{{agent_folder}}' — see: ncl groups list" >&2; exit 1; }
```

## Restart and wire

Restart the service so the adapter registers its routes and the channel type
is known to `ncl`:

```nc:run effect:restart
bash setup/lib/restart.sh
```

Create the line's messaging group (skipped when it exists) and wire it to the
chosen agent group. `wirings create` is idempotent on the pair and applies the
channel's DM defaults — every delegated turn engages the agent, and the link
holder is the line's user:

```nc:run effect:wire
ncl messaging-groups list --json | jq -e --arg p "gpt-live:{{line_id}}" '.data[] | select(.platform_id==$p)' >/dev/null || ncl messaging-groups create --channel-type gpt-live --platform-id "gpt-live:{{line_id}}" --name "Voice line" --is-group 0
ncl wirings create --channel-type gpt-live --platform-id "gpt-live:{{line_id}}" --agent-group "{{agent_folder}}" --session-mode shared
```

Tell the user where to call from:

```nc:operator
The call link is {{public_url}}/webhook/gpt-live/call?t={{link_token}} — keep it private, anyone holding it can talk to {{agent_folder}} on your OpenAI bill. Open it in a browser, allow the microphone, press Call and say hello. Ask something that needs memory ("what did we decide about the launch date?") to see the agent get involved; the page shows captions when the call carries them.
```

## Smoke test without a microphone

Before the first real call, prove the key, the account, and the delegation
round trip from the host alone. The probe opens a Live session with the same
voice prompt the adapter uses, attaches the production sideband, plays a short
caller question synthesized with macOS `say`, answers the delegation the way
the adapter would, and reports whether the voice model spoke the answer back.
It costs a few cents of voice time:

```bash
pnpm exec tsx .claude/skills/add-gpt-live/scripts/live-probe.ts
```

Every line of the summary should read `yes` (the sideband line reads `n/a`:
a sideband cannot attach to a WebSocket-transport session). `session.start
rejected` with `output_creation_failed` on an account where `gpt-live-1` lists
fine means the project has no prepaid credits (see Troubleshooting). On Linux
pass `--clip <mono 16-bit 24 kHz WAV>` instead of relying on `say`.

The second probe exercises the production path itself — the adapter, its
`sdp` route, the sideband attach on a real WebRTC session — with a synthesized
caller and a canned backend reply, so no NanoClaw agent is needed:

```bash
pnpm exec tsx .claude/skills/add-gpt-live/scripts/browser-probe.ts
```

Open the printed URL in a browser and press Start. The terminal shows the
sideband log; the line `>>> the backend reply is being spoken` is the pass.

## Done

Callers talk to the voice model; anything needing the agent is handed over and
the answer is spoken back. Session ids are logged in `logs/nanoclaw.log`; quote
one if you need OpenAI's help with a call. To add a second line for someone
else, append another token to `GPT_LIVE_LINK_TOKEN` (comma-separated), restart,
derive its line id the same way, and wire `gpt-live:<that line id>`.

Phone calls over SIP are the next step: an inbound trunk pointed at
`sip:<PROJECT_ID>@sip.api.openai.com;transport=tls` and a public webhook URL.
To uninstall: see [REMOVE.md](REMOVE.md).

## Troubleshooting

**`Unknown call link` on the page.** The `t` in the URL is not in
`GPT_LIVE_LINK_TOKEN`. Copy the link from the operator note above, or check
`.env`.

**The page says the microphone was refused.** Browsers only grant the
microphone on `localhost` or HTTPS. Use a tailnet HTTPS URL or a tunnel for
anything but a local try.

**`Could not start the call: gpt-live: session create failed: 401`.** The key
in `.env` is wrong or lacks `gpt-live-1` access. `400` usually means the
session config was rejected — the error text names the field.

**`429` with `credit_balance_exhausted` or `insufficient_quota`, or the smoke
test's `session.start` rejected with `output_creation_failed`.** The OpenAI
project has no prepaid credits. GPT-Live-1 is not free-tier eligible and every
session is refused until the balance is positive, even though the model lists
fine and other endpoints answer. Add credits at
https://platform.openai.com/settings/organization/billing/ and rerun the smoke
test. A `429` with `rate_limit` in the message is the concurrent-session cap
instead (25 sessions at tier 1).

**`sideband attach failed`.** The session was created but the host could not
open the server-side socket. Check outbound WebSocket access from the host
(a proxy that strips `Upgrade` headers) in `logs/nanoclaw.error.log`.

**The agent never gets involved.** The voice model delegates only when its
instructions say so. Ask something it cannot know (your calendar, a past
decision). If it still answers alone, check `logs/nanoclaw.log` for
`gpt-live: sideband attached` — without it no delegation reaches the host.

**Delegations arrive but nothing is spoken back.** The line is not wired:
look for `MESSAGE DROPPED — no agent groups wired` in the logs and re-run the
wiring step. If the owner got a channel-request card instead, approving it
wires the line too.

**The caller hears the answer twice.** The agent repeated the voice model's own
words. The transcript marks them as `Assistant:` lines; the formatting skill
tells the agent not to echo them — check it is present under
`container/skills/gpt-live-formatting/`.

**`gpt-live` is missing from `ncl` channel lists.** The factory returned null:
neither `OPENAI_API_KEY` nor `GPT_LIVE_KEYCHAIN_SERVICE` is in `.env`, or
`GPT_LIVE_LINK_TOKEN` is missing. Set them and restart.

**`401 Incorrect API key` although the key was just created.** If the item
was added with `security … -w` and typed at `security`'s own prompt, the key
was cut at 128 characters (that prompt's limit; project keys are longer).
Check with `security find-generic-password -s nanoclaw-openai -a "$USER" -w |
tr -d '\n' | wc -c` — exactly 128 means truncated. Re-add it with the
`printf … read -s KEY …` command above. A stored value that starts with
`read -s` or `printf` means the command itself was pasted at the silent
prompt — run it again and paste only the key when asked.

**`Keychain lookup failed` in the logs.** The item is missing, named
differently, or stored for another account. `security find-generic-password
-s nanoclaw-openai -a "$USER" -w >/dev/null` must succeed in a terminal as the
user the service runs as. A locked login keychain (service started before the
user logged in) fails the same way — restart the service after logging in.
