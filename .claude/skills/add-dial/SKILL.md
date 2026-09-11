---
name: add-dial
description: Add Dial channel integration — a real phone number for SMS and AI voice calls via the Dial platform (getdial.ai). Native adapter — no Chat SDK bridge.
---

# Add Dial Channel

Adds [Dial](https://getdial.ai) — a real phone number for **SMS and AI voice
calls**. Native adapter (no Chat SDK bridge): both directions go through the
`dial` CLI — outbound via `dial message`, inbound via its command-target daemon. NanoClaw doesn't ship
channels in trunk — this skill copies the Dial adapter, its pairing helper, and
their tests in from the `channels` branch. The `pair-dial` setup step is
maintained in trunk, so it is not copied here.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter, pairing helper, and tests

Fetch the `channels` branch and copy the Dial adapter, its pairing store and
user-agent helper (each with its test), and the registration test into place
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/dial.ts
src/channels/dial-pairing.ts
src/channels/dial-pairing.test.ts
src/channels/dial-user-agent.ts
src/channels/dial-user-agent.test.ts
src/channels/dial-registration.test.ts
src/channels/dial-grant.test.ts
src/channels/dial-status.test.ts
```

The `dial-cli` container skill is deliberately **not** copied here.
`container/skills/` is mounted read-only into *every* agent container
(`src/container-runner.ts`), and a group with `skills:'all'` picks up whatever
it finds there — so shipping the skill with the adapter would hand it to agents
on installs that never configured Dial. It is installed only by
`/add-dial-tool`, offered under *Add phone superpowers* below, which is the
skill that actually provisions the CLI the skill documents.

`dial.ts` imports `dial-user-agent.js` at module scope, so omitting that helper
breaks the build and every test that loads the channel barrel.

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if present).
This one line is the skill's only reach-in into the channel core:

```nc:append to:src/channels/index.ts
import './dial.js';
```

### 3. Register the pairing setup step

Add the `pair-dial` loader to the `STEPS` map in `setup/index.ts`, inside the
dormant marker region (skipped if already present — `pair-dial` ships in core, so
this idempotent-skips on a normal install, but is expressed for a clean-upstream
rebuild). The pairing handshake below spawns this step:

```nc:append to:setup/index.ts at:nanoclaw:setup-steps
'pair-dial': () => import('./pair-dial.js'),
```

### 4. Install the packages

Pinned to exact versions — the supply-chain policy rejects ranges and `latest`.
`qrcode` renders the scannable pairing card:

```nc:dep
qrcode@1.5.4
```

The adapter needs no Dial client library: it shells out to the `dial` CLI, which
this skill already requires for inbound. `@getdial/sdk` was dropped because it
depends on `pubnub`, which pulls react-native, Metro and Hermes into the
lockfile for what is a single send — and the CLI ships in lockstep with the Dial
API, so a contract change arrives as a CLI release rather than breaking a
request pinned in the adapter.

### 5. Build

Build first: it guards the adapter's typed core calls and proves the dependency
is installed.

```nc:run effect:build
pnpm run build
```

### 6. Validate

Then run the one integration test.

```nc:run effect:test
pnpm exec vitest run src/channels/dial-registration.test.ts
```

`dial-registration.test.ts` imports the real channel barrel and asserts the
registry contains `dial` — it goes red if the import line drifts. End-to-end
SMS/voice is verified manually once the service runs.

## Sign in to Dial

### Install the CLI

Dial's CLI owns the account credential (an auth file it writes on sign-in), so
the setup uses the `dial` CLI here. Ensure it's installed — this installs it if
it's missing (for the full onboarding/auth reference, see the `dial-cli` skill or
`curl -fsSL https://getdial.ai/skills.md`):

```nc:run effect:external
command -v dial || curl -fsSL https://getdial.ai/install | bash
```

### Identify this install

Calls this setup makes to Dial identify the install. The `dial` CLI prepends
`DIAL_USER_AGENT` to its own token, so the account's requests stay attributable
to this NanoClaw install in Dial's server-side logs. Resolve the token once
(`nanoclaw/<version>`; an unreadable `package.json` degrades to
`nanoclaw/unknown` rather than blocking the install) and prefix every `dial`
command below with it:

```nc:run capture:dial_ua validate:^nanoclaw/\S+$ effect:fetch
node -p "'nanoclaw/'+(require('./package.json').version||'unknown')" 2>/dev/null || echo nanoclaw/unknown
```

### Pin the CLI path

Now pin the CLI's **absolute** path into `.env`. The adapter shells out to `dial`
to register its inbound command target, and it runs inside the NanoClaw service,
which does not inherit your interactive shell's `PATH`. The CLI usually lands in
a version-manager bin directory (`~/.nvm/versions/node/*/bin`, `~/node/bin`, …)
that the service cannot see, so a bare `dial` fails with `ENOENT`, the command
target is never registered, and the channel comes up connected but deaf — no
inbound SMS or calls, with only a line in `logs/nanoclaw.error.log` to show for
it. `DIAL_CLI_PATH` removes the guesswork; `dial.ts` already prefers it:

```nc:run capture:dial_cli_path validate:^/.+ effect:fetch
command -v dial
```
```nc:env-set
DIAL_CLI_PATH={{dial_cli_path}}
```

### Check the sign-in

Check whether you're already signed in:

```nc:run capture:signed_in=.auth.signedIn validate:^(true|false)$ effect:fetch
DIAL_USER_AGENT={{dial_ua}} dial doctor --json
```

### Skip the reuse question when signed out

If you're **not** signed in, go straight to email verification — default the
choice so the branch guard below stays single-valued:

```nc:run capture:reuse_choice when:signed_in=false effect:external
echo switch
```

### Read the account

If you **are** signed in, read which account (for the prompt below) and ask
whether to reuse it or sign in as a different one (matches the old wizard's
"Reuse this account?" prompt, with an explicit way to switch):

```nc:run capture:connected_email=.auth.email when:signed_in=true effect:fetch
DIAL_USER_AGENT={{dial_ua}} dial doctor --json
```
```nc:operator when:signed_in=true
You're already signed in to Dial as {{connected_email}}.
```
```nc:prompt reuse_choice validate:^(reuse|switch)$ when:signed_in=true
Reuse this Dial account, or sign in as a different one? (reuse/switch)
```

### Reuse the account

**Reuse** — no verification needed; with no `--code` the command just (re)installs
the NanoClaw agent skill:

```nc:run effect:external when:reuse_choice=reuse
DIAL_USER_AGENT={{dial_ua}} dial auth verify-otp --agent nanoclaw
```

### Send the code

**Switch (or not signed in)** — verify an email with a one-time code. Collect the email:

```nc:prompt owner_email validate:^[^@\s]+@[^@\s]+\.[^@\s]+$ when:reuse_choice=switch
What's your email? Dial sends a one-time code to verify it. By continuing you create a Dial account and agree to Dial's Terms of Service (https://getdial.ai/terms) and Privacy Policy (https://getdial.ai/privacy).
```

Send the code (`--force` re-sends even if a prior code is pending):

```nc:run effect:external when:reuse_choice=switch
DIAL_USER_AGENT={{dial_ua}} dial auth login {{owner_email}} --force
```

### Verify the code

Collect the code (resolves inline, right after the send above):

```nc:prompt otp validate:^\d{6}$ when:reuse_choice=switch
Enter the 6-digit code from your email
```

Verify it and provision your number (this also installs the NanoClaw agent skill):

```nc:run effect:external when:reuse_choice=switch
DIAL_USER_AGENT={{dial_ua}} dial auth verify-otp --code {{otp}} --agent nanoclaw
```

### Confirm the line

Confirm the account's number — this becomes the agent's public line (its
`platform_id`):

```nc:run capture:platform_id validate:^\+[1-9]\d{6,14}$ effect:fetch
DIAL_USER_AGENT={{dial_ua}} dial number list --json | jq -er '.numbers[0].number'
```
```nc:operator
Your agent's Dial line is {{platform_id}}.
```

### Set the inbound greeting

Set the line's inbound behavior — the system prompt the AI uses on calls *into*
this number. Verification no longer takes an instruction, so a fresh number
starts on Dial's default greeting until this runs:

```nc:run effect:external
DIAL_USER_AGENT={{dial_ua}} dial number set {{platform_id}} --inbound-instruction "You are a friendly AI receptionist answering calls to this number. Greet the caller, ask how you can help, and take a clear message — their name, number, and reason for calling — if you cannot help directly."
```

### Pin the default sender

Make that line the CLI's default sender. Verification saves whichever number
the account considers primary — the **oldest** one — while the line picked above
is the **newest** (`numbers[0]`). On a single-number account those coincide, so
nothing looks wrong; with two or more they diverge permanently, and every
`dial call` / `dial message` that omits `--from-number` goes out from a number
this install isn't listening on. Replies to it are dropped as `no_agent_wired`.

Rewriting `phoneNumber`/`phoneNumberId` in the auth file makes the no-flag path
land on the wired line, so an agent that forgets the selector is still correct:

```nc:run effect:external
f="${XDG_DATA_HOME:-$HOME/.local/share}/dial/auth.v1.json"; i=$(DIAL_USER_AGENT={{dial_ua}} dial number list --json | jq -er --arg n '{{platform_id}}' '.numbers[]|select(.number==$n)|.id') && jq --arg n '{{platform_id}}' --arg i "$i" '.phoneNumber=$n|.phoneNumberId=$i' "$f" > "$f.new" && mv -f "$f.new" "$f" && chmod 600 "$f" && echo "default sender pinned to {{platform_id}}"
```

## Choose who may text the line

A phone number is guessable, and whoever reaches the agent gets a turn with it —
including its `dial` CLI, which is authenticated for the whole Dial account. An
admitted stranger can ask the agent to list every SMS and call on the account,
read call transcripts, or buy another number. Session isolation doesn't prevent
this: the credential is the exposure, not the conversation.

So decide who gets in. `owner` is the safe default; pick `public` only if you
want a line strangers can start conversations on (an inbound receptionist, or
outbound sales where prospects text back):

```nc:prompt inbound_access validate:^(owner|public)$
Who may text this line — `owner` (only the phone you pair next; everyone else is refused) or `public` (anyone who knows the number reaches the agent)?
```

Your answer is written to the line's own `unknown_sender_policy` when the line is
registered below, after the restart (`ncl` is socket-only, so it needs the
service up). It lives in the database from then on — per line, so a second number
added later carries its own answer — and the adapter never rewrites it.

```nc:operator when:inbound_access=owner
Locked to you: only the phone you pair in a moment can reach the agent on {{platform_id}}. Anyone else who texts it is refused — including people your agent calls, so they can't reply by text. To open it later: `ncl messaging-groups update --id <id> --unknown-sender-policy public` (find the id with `ncl messaging-groups list`).
```
```nc:operator when:inbound_access=public
Open line: anyone who knows {{platform_id}} can text the agent and will get a reply. Each person gets their own conversation, but they all reach an agent holding your Dial account credentials — so don't hand out this number casually. To lock it to just you later: `ncl messaging-groups update --id <id> --unknown-sender-policy strict` (find the id with `ncl messaging-groups list`).
```

## Restart

### Restart the service

Restart the service so it loads the Dial adapter, and wait for its CLI socket.
The adapter must be live and polling before pairing — it's the thing that
observes the code you text:

```nc:run effect:restart
bash setup/lib/restart.sh
```

### Start inbound delivery

Wire inbound event delivery and the command target. Both are best-effort: a
sandbox/CI without a user-service supervisor can't run the `listen` daemon, but
outbound still works and inbound can be started manually later (see
Troubleshooting), so these never fail the run:

```nc:run effect:external
DIAL_USER_AGENT={{dial_ua}} dial listen install || true
```

### Register the command target

Point the daemon at the adapter's event handler (same best-effort rule):

```nc:run effect:external
DIAL_USER_AGENT={{dial_ua}} dial local-target add cmd "$PWD/data/dial/handle-dial-event.sh" || true
```

### Register the line (owner-only)

Register the line, carrying the access choice from above onto its own row. One
`platform_id` serves many correspondents, so it's a group (`--is-group 1`) and
each texter becomes a thread inside it. Idempotent — a re-run returns the
existing row, and does NOT reset a policy you have since changed with `ncl`:

```nc:run effect:wire when:inbound_access=owner
ncl messaging-groups create --channel-type dial --platform-id {{platform_id}} --is-group 1 --name "Dial {{platform_id}}" --unknown-sender-policy strict
```

### Register the line (public)

The same row, open to anyone who texts it:

```nc:run effect:wire when:inbound_access=public
ncl messaging-groups create --channel-type dial --platform-id {{platform_id}} --is-group 1 --name "Dial {{platform_id}}" --unknown-sender-policy public
```

## Pair your phone

Dial account auth carries no per-sender binding, so the agent proves you own the
phone you'll text from with a one-time pairing handshake: it issues a 6-digit
code, you text those exact 6 digits to the Dial line, and the live adapter
matches them. Tell the user:

```nc:operator
A 6-digit pairing code (and a scannable QR) is about to appear in this terminal. From the phone you want to use, text just those 6 digits to your Dial line {{platform_id}} — or scan the QR, which opens Messages pre-filled so you just press Send.
```

Run the pairing handshake. It prints the code/QR, streams "waiting…" while it
watches for your text, and resolves the sender's number once the code matches:

```nc:run effect:step capture:owner_handle=PAIRED_NUMBER
pnpm exec tsx setup/index.ts --step pair-dial -- --line {{platform_id}}
```

`owner_handle` (the phone you paired from) and `platform_id` (your Dial line) are
what the owner-wiring step needs. The greeting goes out over your Dial line as
soon as pairing completes.

Now set expectations about outbound SMS, before the operator hits it as a silent
carrier rejection. Calls both ways and inbound texts work from this moment; US
carriers drop outbound SMS from a number that has no 10DLC registration, and the
adapter reports that as a delivery-failure notice rather than anything the
operator can fix in NanoClaw:

```nc:operator
Your number {{platform_id}} can receive texts and calls now. To text US numbers it needs 10DLC registration: $25, usually 3-5 business days, here's the link: https://getdial.ai/dashboard/numbers
```

## Add phone superpowers (optional)

Show the pitch as a boxed note, then ask — mirrors the old wizard's `p.note`
+ confirm:

```nc:operator
Add phone superpowers to your assistant? Say yes so your assistant can send SMS and make AI calls for you from every channel you use it on — Telegram, WhatsApp, and more.
```
```nc:prompt install_tool validate:^(yes|no)$
Install the Dial tool now?
```

If yes, apply the `/add-dial-tool` skill now, as its own document describes. It
asks which agents may use Dial (and blocks the rest at the gateway), puts the
CLI and its skill in the agent image, and registers the account's key with
OneCLI. It needs OneCLI; if that isn't set up it says so, and the channel
still works without the tool:

The tool's own document asks which agents may use Dial. Ask it here instead: a
nested step's stdout is a pipe, so clack cannot echo what is typed into it, and
this skill owns the operator's terminal. List the groups, then collect the answer
and hand it down:

```nc:run capture:has_agents validate:^(yes|no)$ when:install_tool=yes effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no" else "yes" end'
```
```nc:operator when:has_agents=no
No agents exist yet — this install creates its first one in a moment, so there is nobody to choose between. Installing the tool for every agent; re-run `/add-dial-tool` any time to narrow that down.
```
```nc:run capture:agent_groups when:has_agents=yes effect:fetch
ncl groups list --json | jq -r '[.data[] | "\(.id) (\(.name))"] | join(", ")'
```
```nc:operator when:has_agents=yes
Agents on this install: {{agent_groups}}. Giving an agent Dial lets it text and call any number and buy numbers, billed to your Dial account. Agents you leave out are blocked at the gateway (reversible by running /add-dial-tool again). Agents created after this run have Dial until the next run.
```
```nc:prompt dial_agents validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ normalize:trim when:has_agents=yes
Which agents may use Dial? Enter agent ids separated by commas with no spaces (the `ag-…` column), `all` for every agent, or `none` to install the tool with every agent blocked for now.
```
```nc:run effect:step when:has_agents=yes
pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/add-dial-tool --input 'dial_agents={{dial_agents}}'
```
```nc:run effect:step when:has_agents=no
pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/add-dial-tool --input 'dial_agents=all'
```

Then tell the sandboxed agent which line is its own. The container authenticates
through the OneCLI proxy and has **no** auth file, so `defaultNumberId` is null
in there — an agent that omits `--from-number` gets an error, and one that picks
from `dial number list` gets whichever number sorts first, which is unrelated to
what's wired. Only this skill knows the answer, so it has to write it down —
into the mounted skill file, which every container reads on its next spawn:

```nc:run effect:external when:install_tool=yes
if [ ! -f container/skills/dial-cli/SKILL.md ]; then echo "dial-cli skill not installed (the tool installer did not complete) — skipping the wired-line note"; else printf '\n## This install'"'"'s line\n\nAlways pass `--from-number {{platform_id}}` on every `dial call` and `dial message`. That is the line this NanoClaw install is wired to; any other number on the account reaches nobody and replies to it are dropped.\n' >> container/skills/dial-cli/SKILL.md && echo "wired line recorded for the sandbox: {{platform_id}}"; fi
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`). To add a second
Dial number later, see the `/add-dial-number` skill.

## Channel Info

- **type**: `dial`
- **terminology**: Dial calls it a "number" or "line." One number is a single threaded line — each texter/caller gets their own thread.
- **platform-id-format**: the bare E.164 number (e.g. `+14155550123`) — unlike prefixed channels, the number itself is the id.
- **how-to-find-id**: Do NOT ask the user for an id. Dial registration uses pairing — run `pnpm exec tsx setup/index.ts --step pair-dial -- --line <E.164>`. The step prints a 6-digit code + QR; tell the user to text just those 6 digits to the Dial line. Success emits a `PAIR_DIAL` block with `STATUS=success`, `PLATFORM_ID` (the bare line), and `PAIRED_NUMBER` (the bare sender E.164). The service must be running — the adapter is what observes the code.
- **supports-threads**: yes (each correspondent is a thread on the line, with its own session)
- **typical-use**: A real phone number for SMS and AI-handled voice calls — receptionist, notifications, 2FA relay.
- **default-isolation**: One line → one agent group. Who may reach it is the operator's choice at setup (`inbound_access`): `owner` admits only the paired phone, `public` admits everyone. Defaults to owner-only.

## Troubleshooting

**`dial: command not found` / the CLI gate fails.** The Dial CLI isn't on PATH. Run `curl -fsSL https://getdial.ai/skills.md` and follow its install steps, then re-run this step.

**The email code never arrives.** Check spam, confirm the address is one you can read, and re-run — `dial auth login <email> --force` re-sends. The code is sent by Dial's servers, not NanoClaw.

**Inbound texts/calls don't reach the agent.** `dial listen install` needs a user-service supervisor (launchd/systemd `--user`); sandboxes/CI don't have one. Outbound still works. Start it manually with `dial listen install` once a supervisor is available, and confirm the command target with `dial local-target list`.

**Pairing never completes.** The live adapter observes the code, so the service must be running — the restart step comes before pairing for exactly this reason. Text *just* the 6 digits to the Dial line; a wrong message is ignored. Codes expire after 10 minutes, so if it times out (5 min) or the code goes stale, re-run this step for a fresh one.

**"Pairing is paused for about N min."** Five wrong codes texted to the line inside 10 minutes locks that line for 15 — a brute-force guard, and while it holds even the correct code is refused. The wizard prints this warning when it happens; nothing is texted back to the sender, by design. Wait it out and re-run this step for a fresh code, or override the thresholds with `DIAL_PAIRING_MAX_ATTEMPTS` / `DIAL_PAIRING_ATTEMPT_WINDOW_MS` / `DIAL_PAIRING_COOLDOWN_MS` / `DIAL_PAIRING_TTL_MS`.

**Everything green but no replies.** Run `pnpm exec vitest run src/channels/dial-registration.test.ts` — red means the barrel import drifted, so re-run the Apply steps. If green, restart again (`bash setup/lib/restart.sh`) and check `logs/nanoclaw.error.log`.
