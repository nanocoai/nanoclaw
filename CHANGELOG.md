# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Unreleased]

NanoClaw 2026.10.1-rc.2 is the second release candidate for 2026.10.1. Installs on the `beta` channel get this candidate; `stable` stays on 2026.10.0 until 2026.10.1 is published. Since 2026.10.1-rc.1 it moves OneCLI to 1.45, where new agent groups get only their model key and other keys go to the groups you choose, makes the webhook server listen only on this machine by default, applies egress lockdown to agents that were already running, asks for Node's October 2026 security releases, and lets Claude agents read PDFs; Google Chat now checks that its webhooks come from your app. It also lets agents create other agents from templates, adds Cursor as an agent provider, and moves locally built agent images to Claude Code 2.1.296 with Claude Haiku 5.5. Setup waits for a slow first reply and says when that reply failed, approval cards appear in the thread you are waiting in, and fewer agent runs fail. Six changes need action from some installs, among them the OneCLI upgrade, the webhook address and two new Google Chat settings, so check the section below before you update.

### ⚠️ Before you update

- [BREAKING] **Chat SDK channels move to adapter 4.41.1, which fixes Telegram messages with links that were never delivered.** Affected: installs where `grep -o '"@chat-adapter/[a-z]*"' package.json` prints anything (Telegram, Slack, Discord, Google Chat, Teams, WhatsApp Cloud, GitHub, Linear). Fix: `/update-nanoclaw` refreshes installed channels; after a manual merge, rerun `/add-<channel>` for each one. Google Chat: @mentions in spaces now need `GOOGLE_CHAT_BOT_USER_ID=users/<id>` in `.env` (DMs work without it; without it the log says "Google Chat botUserId is not configured" at startup): once the app has replied to you in a DM, list that DM's messages with the Chat API (`spaces.messages.list`), copy the `sender.name` of a message whose sender `type` is `BOT`, and restart the service. Slack agent-to-agent rooms: a sibling bot now arrives as `slack:bot:U…` instead of `slack:bot:B…`, so approve each sibling bot once more. Check: each channel answers a test message. Rollback: `pnpm exec tsx scripts/update-nanoclaw.ts rollback --id <transaction-id>` ([rolling back](https://docs.nanoclaw.dev/operate/upgrading#rolling-back)).
- [BREAKING] **Iron Proxy installs that connected Codex with ChatGPT before this release must sign in to Codex again.** Detect, from the NanoClaw folder (works while the service is stopped): `f=data/session-materials/iron-control/codex.json; [ -f "$f" ] && grep -q '"mode":"chatgpt"' "$f" && ! grep -q '"accountId"' "$f" && echo affected`. Once running, an affected install's Codex agents answer only with the failure notice ("Sorry, something went wrong and I couldn't answer") and the agent container log shows `selected workspace missing from routing discovery`. Why: Codex 0.156 and later check the login's workspace id, and older Iron logins never recorded it. Fix: `pnpm exec tsx setup/index.ts --step provider-auth codex`, then check that a Codex agent answers. OneCLI installs are affected only when the vault holds several ChatGPT logins or one without a recorded id; the host log then says "OneCLI login stand-in keeps its placeholder account id": delete the extra or stale login (`onecli secrets list`, then `onecli secrets delete --id <id>`), run the same command, and grant the new secret to each agent that had the old one, as `docs/onecli-upgrades.md` in your install describes. Rollback: return to the previous release.
- [BREAKING] **Forks and hand-made templates: the template code moved and `templates/` is now ignored by git.** Affected: fork code that imports `cloneRegistry`, `listTemplatesFromDir`, `copyTemplate` or `DEFAULT_TEMPLATES_SOURCE` from `setup/templates.ts` (it stops compiling), forks that edit the `GROUP_SCOPE_RESOURCES` line or the stamper's `ensureContainerConfig` line, forks that point setup at their own template library, and anyone who keeps a hand-made template in `templates/`. Why: templates fetched by setup or by an agent are install state and must not block `/update-nanoclaw`, and setup now lists a library from its `index.json`. Fix: import `cloneRegistry` and `listTemplatesFromDir` from `src/templates/library.ts` and `await cloneRegistry()`; `copyTemplate` is gone, so call `ensureTemplateLocal`; a fork that changed `DEFAULT_TEMPLATES_SOURCE` edits `LIBRARY_REPO` (`owner/repo`) and `LIBRARY_BRANCH` in `src/templates/library.ts` instead; re-anchor fork edits on the new lines; keep a new hand-made template in git with `git add -f templates/<ref>`; give your own library an `index.json` at its root in the same shape as `nanocoai/nanoclaw-templates` (`{ "schema": 1, "categories": { "<category>": [{ "ref": "<folder>", "name": "...", "description": "..." }] } }`). Check: `pnpm exec tsc --noEmit` passes and setup's library picker lists your templates ([building templates](https://docs.nanoclaw.dev/templates/building)). Rollback: revert this release; fetched templates then show as untracked in `git status`, so delete them or `git add` the ones to keep.
- [BREAKING] **OneCLI installs: upgrade the gateway to 1.45.0 and the `onecli` CLI to 2.11.0, where agents get only the keys you grant them.** Detect: the gateway's `/api/health` reports a version older than 1.45.0, or `unknown` (Iron Proxy installs skip this). Why: OneCLI 1.44 replaced secret modes with per-agent grants, and 1.45 is the last version that converts existing installs, so do not skip past it. Fix: before restarting, follow `docs/onecli-upgrades.md` in your install ([the same guide on GitHub](https://github.com/nanocoai/nanoclaw/blob/main/.claude/skills/add-onecli/payload/docs/onecli-upgrades.md)); it backs up the gateway database, stops if the conversion would delete your rules, and covers the CLI binary. If you use `/add-dial-tool`, delete the Dial key first (see the Dial item below). Existing groups keep what the conversion gives them; new groups get only their model credential, and on a 1.42 gateway new groups still get every key until you upgrade. To give a group a tool, re-run that tool's skill (for example `/add-vercel`) and pick the group; with `/add-tavily-tool`, re-run its Phase 5 so paid-key upgrades attach the key. `/add-vercel`, `/add-tavily-tool` and `/add-dial-tool` refuse a gateway that is not 1.45. If your Claude key in OneCLI is not named `Anthropic` (or your Codex key `Codex` or `openai`), new groups get no key: run that provider's login again after upgrading (`pnpm exec tsx setup/index.ts --step gateway-auth claude`, or `codex`). Check: `/api/health` reports 1.45.0 and a new agent group answers. Rollback: restore the database backup the guide takes.
- [BREAKING] **The webhook server now listens on 127.0.0.1 by default.** Tunnels and reverse proxies on the same machine keep working. Affected: a proxy on another machine, or anything in Docker on Linux that calls back to the host, such as a Mattermost server; webhooks stop arriving, and the log shows `Webhook server started host="127.0.0.1"`. Fix: set `WEBHOOK_HOST=0.0.0.0` (or one interface's IP address; a name such as `localhost` stops the host at startup) in `.env` and restart. Check: a message on that channel gets an answer. Rollback: the same setting restores the old behavior.
- [BREAKING] **Google Chat installs need two new settings, or the channel does not start.** Google Chat now verifies that webhooks come from your Workspace add-on Chat app, using `GOOGLE_CHAT_ENDPOINT_URL` and `GOOGLE_CHAT_PROJECT_NUMBER` (digits) in `.env`; `/update-nanoclaw` brings the new adapter but cannot ask for them. Detect: the log says "Google Chat needs GOOGLE_CHAT_ENDPOINT_URL and GOOGLE_CHAT_PROJECT_NUMBER (digits) in .env to verify webhooks". Fix: re-run `/add-gchat`, which keeps your existing values and asks for the endpoint URL, the project number and the bot user id for @mentions in spaces, or set both values by hand and restart. The Chat app must be a Google Workspace add-on, and converting an app to one cannot be undone. Check: a test message gets an answer. Rollback: `pnpm exec tsx scripts/update-nanoclaw.ts rollback --id <transaction-id>`.
- **`/add-dial-tool` users: delete the Dial key before upgrading OneCLI, then re-run `/add-dial-tool`.** On OneCLI 1.45 it gives the Dial key only to the agent groups you choose, and new groups get Dial only when you add them; Dial is off for those few minutes instead of open to every agent. The upgrade guide has the delete command. NanoClaw's `ONECLI_PROJECT_ID` and the `onecli` CLI's project (`onecli config set project`, or `ONECLI_PROJECT`) must match or both be unset: when they differ, the re-run stops and writes nothing to OneCLI. An agent group name with a line break no longer changes which groups keep Dial.
- **Update Node to its October 2026 security release.** Setup now requires Node 22.23.4, 24.22.1 or 26.12.1 or newer and refuses the end-of-life 23 and 25; locally built agent images move to Node 22.23.4, pinned by digest, and hardened installs get it with a later image. NanoClaw keeps running on an older Node, but re-running setup stops. After `/update-nanoclaw`, run `bash setup/install-node.sh`, then re-run `bash nanoclaw.sh` so the service uses the new Node. If Node comes from nvm, fnm, volta or asdf, update it there. Groups with extra packages also need `ncl groups restart --id <group-id> --rebuild`.
- **Egress lockdown now covers agents that were already running when it was turned on**: they restart on the locked network when the host restarts. If the lockdown network exists but is not internal (only a network made by hand, or a setting that points at an ordinary one), agents no longer start and the host log says "Refusing to spawn with open egress". Fix: list what is attached with `docker network inspect nanoclaw-egress`, detach it (`docker network disconnect nanoclaw-egress <container>`), then `docker network rm nanoclaw-egress`; the next agent start recreates it as internal. Iron Proxy installs name it `nanoclaw-egress-<slug>`, and `NANOCLAW_EGRESS_NETWORK` can set another name.
- **Locally built agent images move to Claude Code 2.1.296 and Agent SDK 0.3.296, where Claude Haiku 5.5 replaces Haiku 4.5.** On the Anthropic API, Claude Code's background requests and groups set to `haiku` move to Haiku 5.5, which costs a tenth of Haiku 4.5's price for prompts up to 100K tokens. Hardened installs keep Claude Code 2.1.280 and Haiku 4.5 until an image for this release is listed.
- **Hardened installs move to the image built from v2026.10.0.** A pull now takes the image listed in `agent-images.json` on `main` for the newest release in the install's history, so a new hardened image reaches installs without a new release. Release candidates never get an image of their own, so this one uses v2026.10.0's (Claude Code 2.1.280, newer than the old pinned build), and the pull's "agent-runner lock drift" warning is expected. This candidate lists a newer build of that image, made on 2026-10-21, so `/update-nanoclaw` pulls it again. Run `pnpm exec tsx setup/index.ts --step registry -- --refresh` to move onto it ([hardened runtime](https://docs.nanoclaw.dev/guides/echo-hardened-runtime)).
- **Codex groups with no model set start new threads on GPT-6.1 Sol.** `/add-codex` now pins `@openai/codex` 0.162.1; existing threads keep their model. To stay on the old one, run `ncl groups config update --id <group-id> --model gpt-6-astra`, then `ncl groups restart --id <group-id>`.

### ✨ New

- **Agents can create other agents from templates.** Ask for one in chat, pick from `ncl templates list` or the public library, and the agent builds it. Setup's template library list now shows what each template does ([using templates](https://docs.nanoclaw.dev/templates/using-templates)).
- **Cursor is an agent provider.** The new `/add-cursor` skill runs Cursor's Agent SDK, and setup offers Cursor in the provider picker; it needs a locally built agent image ([providers](https://docs.nanoclaw.dev/extend/providers)).
- **Setup waits for a slow first reply instead of failing.** The first-chat check waits 2 minutes, then asks whether to keep waiting, and shows each stage (sandbox, agent runtime, model) with its time, so local models that take minutes to load no longer fail setup. Runs without a terminal now stop after 2 minutes instead of 30 seconds.
- **Agents on slow local models are no longer cut off mid-turn.** Raise `NANOCLAW_ABSOLUTE_CEILING_MS` (default 30 minutes) or `NANOCLAW_CLAIM_STUCK_MS` (default 60 seconds) in `.env`; the host log names which one fired. Restart the service after a change; installs that set neither are unaffected ([environment variables](https://docs.nanoclaw.dev/reference/environment-variables)).

### 🛠️ Fixes

- **Setup tells you when your assistant's first reply failed.** Instead of saying the assistant is ready (for example after a bad API key), it shows the agent's error, names the log files and links the troubleshooting docs; `pnpm run chat` exits with code 4 on a failure notice. When an agent has no error of its own to share, every channel's failure notice now reads "Sorry, something went wrong and I couldn't answer" and links the troubleshooting docs.
- **Agents no longer lose or repeat a reply around `send_message`.** An agent that sent something with `send_message` and then left its answer unwrapped is shown what it already sent and asked to finish, and an exact repeat is not sent twice. On streaming providers, a reply sent with `send_message` and followed by plain closing text costs one extra model turn.
- **Fewer failed agent runs.** On Docker Desktop, a message that arrives while an agent is replying no longer fails the run, and "Permission denied" replies to admin-only commands are sent directly to the chat. On every install, `ncl` and agent tools no longer hit intermittent "database is locked" errors.
- **Approval cards appear where you are waiting and are easier to read.** When an agent in a thread of your own DM asks for approval, the card and its "Reject with reason" prompt appear in that thread. Cards show command arguments and agent-to-agent messages in a code block, and names and the install reason quoted on one line. An approval an agent asks for, or an `ask_user_question`, whose title and question together run over 2,000 characters is refused, and the agent is told the limit so it can shorten it; `ask_user_question` also returns an error within seconds of the host giving up on delivering its card, instead of waiting out its 300-second timeout.
- **The background service finds the tools it was installed with.** On macOS it now includes `/opt/homebrew/bin` and the Node.js folder, so Apple Silicon installs using Homebrew or Apple Container no longer crash at start; on Linux it includes the Node.js folder (for example from nvm). Existing installs get it by running `pnpm exec tsx setup/index.ts --step service` once.
- **`/update-nanoclaw` no longer stops at its validate step on installs with Slack.** The skill refresh now credits each channel import to the skill that adds it, so it stops looking for Slack skills that don't exist. The fix comes with the update itself.
- **Discord: Approve on an approval card now approves.** Button clicks were misread, so approvals were recorded as rejections and answers to questions came back garbled.
- **Claude agents can read long PDFs you send them.** Installs that build their own agent image get it from the image rebuild in `/update-nanoclaw`; groups that installed their own packages also need `ncl groups restart --id <group-id> --rebuild`. Hardened installs get it with a later image.
- **Google Chat attachments reach the agent.** On channels whose message ids contain `/`, such as Google Chat, files were dropped and the agent saw only the file name. When someone shares a file from Google Drive, the agent now says it can't open Drive files and asks for the file to be pasted or dragged into the chat.
- **Resend email replies are sent.** Agent replies and the "Connect yourself" hello failed with `Invalid thread ID format`; they now go out, and a reply lands in the email thread the person last wrote in. `/update-nanoclaw` brings it; after a manual merge, rerun `/add-resend`.
- **Smaller fixes.** An agent reads its own replies from other threads of the same chat as its own, not as another agent's; `ncl groups delete` also removes the group's host bookkeeping rows, and agents that could message it stop listing it right away; creating an agent from a template no longer fails when an agent that has not run yet holds that name; a Slack bot set up for channels only no longer sends you an FYI each time it turns away a DM; `ncl messaging-groups delete` also removes the group's wirings, its own sessions and pending approvals instead of failing with a foreign key error, and removing iMessage uses it; creating an agent refuses a name whose group folder would be invalid (too long, or reserved such as "Global") before anything is written, and says why; setup accepts Anthropic's newer API key types (`sk-ant-usr`, `sk-ant-svc`), which must be scoped to one workspace; Linux Signal setup installs signal-cli 0.14.9, which fixes sends to new contacts hanging (rerun `setup/install-signal-cli.sh`, then restart the service); and the `/add-dashboard` dashboard keeps updating when a transcript grows past about 512 MB and no longer re-reads every transcript each minute (rerun `/add-dashboard` to get it).

### 🔒 Security

- **`/add-resend` installs a Resend adapter with no known advisories.** The pin moves from 0.1.1 (4 moderate findings through `uuid`) to 0.3.0, and `/update-nanoclaw` moves existing email installs to it (after a manual merge, rerun `/add-resend`). The webhook now answers before the message is processed, so a message that fails is not retried, and replies are sent as HTML with a plain-text part that drops link targets.
- **Signal setup checks the signal-cli download's sha256** before installing it.
- **OneCLI setup keeps keys off the command line.** Setup now gives keys to the `onecli` CLI through a private temporary file or stdin, and hides them in error messages. If setup ever failed while saving your Anthropic key or OneCLI API key, rotate that key and delete the old files in `logs/setup-steps/` and `logs/setup.log`.

### 🔧 For custom installations

- **Custom container code that reads `inbound.db`** through `openInboundDb()` or `getInboundDb()` (`mailbox/sqlite/connection.ts`) must use `readInbound((db) => ...)`: `openInboundDb()` is gone, and `getInboundDb()` now works only in tests.
- **`/add-codex` ships its provider inside the skill**, so installs and forks no longer need the providers branch; on an older core its instructions tell you to update core first. Codex archives pick up core's header fix (the thread-id line no longer renders as a heading).
- **Provider skills can archive exchanges through core.** Use `container/agent-runner/src/provider-contracts/exchange-archive.ts`; refreshing `/add-codex` deletes the old copy in `providers/exchange-archive.ts`, so a custom provider that imports it must switch.
- **A gateway credential can target one exact path on a host.** The provider credential seam moves to version 2: a custom provider skill that requires exactly version 1 must accept 1 or later, a skill that sets `path` must require 2, and a custom gateway must declare `connectionPaths: true` to accept path-scoped credentials.
- **The agent image no longer installs `cron-parser`** or its `luxon` dependency (about 4.9 MB); scheduling still runs on the host. Custom container code that imported them must add them back.
- **Forks that pointed the `versions.json` agent-image pin at their own mirror** must move that reference to `NANOCLAW_AGENT_IMAGE_REF`, because the `agent-images.json` list now comes first.
- **Forks no longer run the agent-image refresh workflow**, which failed every 6 hours outside `nanocoai/nanoclaw`.
- **OpenCode: `OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES` and `OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT` are gone**; they never took effect.

## [2026.10.0] - 2026-10-09

NanoClaw 2026.10.0 is the first release with calendar version numbers and the first one `/update-nanoclaw` installs by default: updates now follow published releases instead of the tip of `main`. It was tested first as 2026.10.0-rc.1 and 2026.10.0-rc.2 on the `beta` channel. It also makes updates and rollbacks more dependable, lets Iron Proxy reach a keyless local model over plain HTTP, routes the service through an outbound proxy when you have one, and shows Claude's own reason when a run fails. Iron Proxy installs need one setup rerun, so check the section below before you update.

### ⚠️ Before you update

- [BREAKING] **OneCLI installs: upgrade the OneCLI gateway to exactly 1.42.0, which closes a credential-injection bypass.** `/update-nanoclaw` never upgrades a running gateway, so this step stops the update until it is done. Follow `docs/onecli-upgrades.md` in your install ([the same guide on GitHub](https://github.com/nanocoai/nanoclaw/blob/main/.claude/skills/add-onecli/payload/docs/onecli-upgrades.md)): its detect step says when it does not apply (Iron Proxy installs skip it); otherwise save 1.42.0 as the gateway version, upgrade, confirm that the running image is 1.42.0, and note the old version for its rollback step. Do not go past 1.42.0: OneCLI 1.43 and later break assigning credentials to agents and are not supported yet. New installs already get 1.42.0.
- **`/update-nanoclaw` now installs the newest release, not the tip of `main`.** The channel is set by `NANOCLAW_UPDATE_CHANNEL` in `.env`: `stable` (the default) follows releases, `edge` follows `main` as before, and `beta` takes release candidates when there are any. Your first update after this release still runs your current update steps, so it lands on the tip of `main`, which is this release only until new changes merge; from then on, updates follow the channel. An install that is already newer than the latest release is never moved back: the updater asks whether to keep following `main` or wait for the next release, and saves the answer. To choose yourself later, run `pnpm exec tsx scripts/update-nanoclaw.ts set-channel --channel edge` (or `stable`).
- **Iron Proxy installs: rerun the Iron setup once after updating.** It rebuilds the proxy on upstream v0.52.0 (expired proxy certificates are regenerated, host rules match case-insensitively), moves the approval bridge to `@grpc/grpc-js` 1.14.5 (fixes GHSA-m9gg-hp2v-232j and GHSA-f596-whhp-79r4), and lets `git clone`/`fetch` and the agent browser authenticate through the proxy. Run `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --with-control`. The agent browser now trusts the gateway's certificate, so HTTPS pages behind Iron load: installs that build their own agent image get it from the image rebuild in `/update-nanoclaw`, while installs that pull the hardened image get it only with the next image (until then the browser stays broken there; the agent still starts). OneCLI installs need nothing.

### ✨ New

- **Updates follow release channels.** Choose `stable`, `beta` or `edge` per install; the channel and the exact release are recorded in `data/upgrade-state.json`, so support can see what an install tracks.
- **With Iron Proxy, a keyless model on the same machine works over plain HTTP.** Enter `http://host.docker.internal:<port>/v1` and restart; setup checks that the port answers like a model server, only that port and the OpenAI inference routes are reachable, and requests to it no longer ask for approval on every call. Models that need a key still need `https://` on a public DNS name.
- **The service can reach the internet through an outbound proxy.** It now uses `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` and `NO_PROXY` from your setup shell or `.env`; a OneCLI gateway on a local address is added to `NO_PROXY` automatically. Needs Node 22.21+ or 24.5+, and setup warns if your Node ignores the proxy.
- **A failed Claude run tells you why.** For known failures such as an invalid API key, the chat shows Claude's short message (for example "Invalid API key · Fix external API key") and who can fix it, instead of "The agent run failed".
- **Iron Proxy can skip the approval card for reads that send no credential.** Set `NANOCLAW_GATEWAY_UNCREDENTIALED_READS=true` in `.env`, and a GET or HEAD request with no body skips the card when no stored credential could apply to its host; the egress allowlist still limits where it can go. Off by default. If you already reran the Iron setup on a release candidate, rerun it once more to use this, because it rebuilds the approval front; until then every card stays.

### 🛠️ Fixes

- **`/update-nanoclaw` is more dependable.** A failed update no longer deletes half of `data/` when it rolls back: the snapshot is swapped in by rename, and if a restore still fails nothing is deleted and the error prints the commands that finish it. It works again from 2.4.0 (it stopped with "Cannot find module"), detects the installed gateway even when pnpm prints a warning, keeps Iron Proxy running across the update, and no longer reports success while the old service is still running. A rollback now stops the host that is actually running and stops agent containers before restoring your data. Updates that bring a new tsx or esbuild no longer crash at the end of cutover on installs with a gateway (the fix is in the update controller, so it covers the update that brings it). A fresh install can now be updated without manual commits: setup commits the files it adds as local `setup: apply <skill>` commits (set `NANOCLAW_SETUP_COMMIT=0` to skip them). When an update changes only your gateway's skill files, it now refreshes the gateway's host code too.
- **Claude turns are cheaper again.** New Claude groups no longer default to the `Concise` output style, which stopped the prompt cache from reading the conversation back, so every turn paid to cache it again; the concise instruction now lives in the agent's `CLAUDE.md`. A group that already has `Concise` keeps it: set `outputStyle` to `default` (or delete the key) in `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`.
- **Agents behave better in chats.** The typing indicator stays on while Claude writes a long answer, agents no longer trade "The agent run failed" messages with each other forever, and they read each turn's subject from their own message and history, asking when a bare "this" is ambiguous. Deleting an agent with `ncl groups delete` now stops its container within about a minute.
- **Setup is clearer when something goes wrong.** A failing skill step shows its own reason, Codex and OpenCode installs are no longer offered the Claude CLI, a failed host restart says why the host is not ready, and the setup log records whether the assistant answered the first test message. OpenCode setup checks a local model URL against your gateway at the prompt, Iron Proxy setup skips a malformed allowlist entry and says how to fix it, and on arm64 Linux it stops early, with the command to turn on emulation, when Docker cannot run the Iron Control image. Setup's OneCLI step works under a strict `077` umask, and uninstalling removes the Iron Control database so a reinstall in the same folder starts clean.
- **OneCLI gateway upgrades now stay on 1.42.0.** The upgrade guide saves the version in `~/.onecli/.env` and checks which image is running, so a later restart cannot move the gateway to a newer release; 1.43 and later are not supported yet.
- **The OneCLI upgrade guide is safer when the gateway version is missing or too new.** Its save commands now stop on an empty version, which used to make Docker Compose run the newest gateway and change its database, and the guide backs up the gateway database before the upgrade. If a newer gateway has already run, the guide sends you back to the pinned version instead of the rollback step, which could start the newer one again.
- **Updates on macOS no longer fail and roll back when the service is slow to stop.** The updater now waits for NanoClaw to exit fully before it continues, instead of failing with "Bootstrap failed: 5: Input/output error".
- **A fresh install that adds a channel starts again after a restart.** Setup's own local commits now carry the upgrade marker forward, so the startup check no longer stops NanoClaw with "update did not go through the supported path" after the first reboot or update.
- **Dial can be added again on OneCLI gateway 1.42.0.** `/add-dial-tool` now scopes Dial with a OneCLI policy rule instead of the legacy rules the gateway rejects, and publishes it before the Dial key is stored. Older gateways and 1.43+ stop with a message naming the supported version.
- **Smaller fixes.** OpenCode agents avoid a Bun hang in the memory hook; `send_card` no longer breaks requests to llama.cpp-served models (non-ASCII link URLs are encoded automatically); OneCLI credential errors during setup name the credential being set up instead of always saying "OpenCode"; a scheduled-task pre-script that hits its 30 s timeout now stops its child processes too; logging a circular object or a BigInt no longer crashes the host; `ncl approvals help` and `ncl dropped-messages help` list exactly the values the host writes; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set in `.env` or the service environment now reaches Claude agents (it was ignored); WhatsApp linking no longer hangs when WhatsApp rate-limits setup, and stops at once with the reason if the current WhatsApp Web version cannot be fetched; Node 26 no longer prints a `module.register()` warning; the OneCLI upgrade guide checks the gateway at the address in `ONECLI_URL`, so it works on Linux installs where the gateway listens on the Docker bridge; and the `/add-imessage` local backend on a Mac opens `chat.db` again (if you installed it before, rerun `/add-imessage` and choose `local`).

### 🔒 Security

- **WhatsApp uses Baileys 7.0.0-rc14, which fixes a critical message-spoofing flaw (GHSA-qvv5-jq5g-4cgg).** `/update-nanoclaw` moves existing WhatsApp installs to the fixed version, and linked devices do not need to link again.
- **Agents can no longer redirect host file operations outside their own folders.** A compromised or prompt-injected agent could swap a directory inside its session or group folder for a symlink and make the host read, write or delete files elsewhere as the host user. No configuration change is needed. See [GHSA-frvf-5rf5-89fq](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-frvf-5rf5-89fq), [GHSA-7wx5-9p7v-wvhp](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-7wx5-9p7v-wvhp), [GHSA-vwj5-j44r-v364](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-vwj5-j44r-v364) and [GHSA-9j3v-9hwg-v896](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-9j3v-9hwg-v896); thanks to @KyleCard, @roisec, @prathish-ks and @sajdakabir for reporting.
- **Setup downloads the OneCLI installer over HTTPS only.** The address used to have no `https://`, so on an untrusted network the download could be swapped during setup. Existing installs need nothing. See [GHSA-628g-jj3x-6mp9](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-628g-jj3x-6mp9); thanks to @ShaharGigi for reporting it.
- **Only admins can run `/clear` and `/upload-trace` now, however the command is typed.** A group member who was not an admin could get past the permission check by adding text to the end of a command, such as the `@botname` Telegram adds in group chats. The check and the agent now read commands the same way, including the other names the Claude SDK accepts for them (like `/reset` for `/clear`). See [GHSA-g3gp-6777-8p9g](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-g3gp-6777-8p9g); thanks to @sajdakabir for reporting it.
- **Group-scoped agents can no longer read other agent groups through `ncl`.** An empty or differently spelled group flag (for example `--agent-group-id` next to `--agent_group_id`) got past the group check and let an agent list other groups' destinations. Installs with one agent group were not affected. See [GHSA-r7fr-2v6h-rhqf](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-r7fr-2v6h-rhqf); thanks to @sajdakabir for reporting it.
- **Mattermost setup checks the owner's user ID before using it.** Setup took this ID from the Mattermost server and used it in a command without checking it, so a malicious server, or someone who could change traffic to a server on plain `http://`, could run commands as the user running setup. Existing installs need nothing. See [GHSA-8w49-2gv4-3x6w](https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-8w49-2gv4-3x6w); thanks to @ShaharGigi for reporting it.
- **Host logs keep a value's own redaction** (its `toJSON()`) even when the logged data also holds a BigInt or a circular reference.
- **Setup's debugging helper asks before it runs commands or edits files.** Claude's headless helper is read-only.
- **Outbound proxy settings, which can include a password, are kept in an owner-only file** instead of the service definition. If you use an authenticated proxy, rerun setup's service step (`pnpm exec tsx setup/index.ts --step service`) to move it out of your existing service file.
- **Discord's local event relay only accepts events from NanoClaw's own Discord connection**, so other programs on the same machine can no longer send it fake button clicks. No action needed.

### 🔧 For custom installations

- **Version numbers are now calendar-based (`YYYY.M.PATCH`).** 2026.10.0 follows 2.4.0 and sorts after it, so tools that compare versions keep working; a dependency range such as `^2` will not match it. Release tags stay `vX.Y.Z` and annotated.
- **Forks that merge `main` by hand** can keep doing so; to keep `/update-nanoclaw` on `main` instead of releases, run `pnpm exec tsx scripts/update-nanoclaw.ts set-channel --channel edge` once.
- **Provider contracts can list exact model endpoints.** A provider skill sets `modelAuthorities` to `host:port` pairs that skip the gateway's default approval, as `modelDomains` does for whole domains.
- **The published agent image is unchanged in this release.** Installs that pull the image keep the 2026-08-25 build; the agent-runner dependency refresh in this release reaches them with the next image, built from this release's tag. Installs that build the image locally get it now.

## [2.4.0] - 2026-09-23

NanoClaw 2.4.0 adds credential gateways installed through skills (OneCLI stays the default, Iron Proxy is new), community-portal setup for Echo's hardened image and a managed Slack app, install-wide and per-group model and speed controls, a Mattermost channel, and a reworked OpenCode provider. Agents now receive all of their capability instructions, replies stay in the thread they answer, and host restarts and `/update-nanoclaw` are more reliable. The default Claude model moves to Opus 5.5 and new Codex threads to `gpt-6-astra`, so check the section below before you update.

### ⚠️ Before you update

- [BREAKING] **Custom source that composes agent instructions must move to the new module.** `CLAUDE.md` was a list of `@` imports into `/app`, and Claude Code silently drops imports that resolve outside the project directory, so eight of nine instruction sections never reached the model; it is now one flat file with every source inlined, shared with the Codex provider. `src/claude-md-compose.ts` is now `src/project-doc-compose.ts`, `composeGroupClaudeMd(group)` became `composeGroupProjectDoc(group, groupDir, spec)`, and the `/app/CLAUDE.md` and `/workspace/agent/.claude-fragments` mounts are gone. **Migration:** run `grep -rn --exclude='*.test.ts' "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/`; no hits means nothing to do, otherwise repoint the import and pass `DEFAULT_PROJECT_DOC` as the third argument. Then clear the inert leftovers once with `rm -rf groups/*/.claude-fragments groups/*/.claude-shared.md`. Standard installations need no source edits; see [docs/release-2.4-update.md](docs/release-2.4-update.md).
- [BREAKING] **Forks that merge upstream by hand must install their credential gateway before restarting.** Credential gateways now install through skills: `/add-onecli` supplies OneCLI and `/add-iron-proxy` adds optional Iron Proxy support, with a shared contract owning session lifecycle and human approvals. OneCLI remains the simple-setup default, gateway selection appears only in advanced setup, and upgrades preserve the existing selection. Setting `NANOCLAW_GATEWAY_PROVIDER` alone does not install its implementation, and the host refuses to start without a registered gateway. **Migration:** `/update-nanoclaw` materializes the selected gateway before cutover; a manual merge must apply `/add-onecli` (or the selected gateway's skill) before restarting. See [gateway migration](docs/gateway-seam.md#migrating-an-existing-installation) for detection, verification, and rollback.
- **Claude groups with no model set move to Opus 5.5, which changes cost and usage-limit burn.** API-key installs move from Opus 5, and Pro and Team Standard installs from Sonnet. To keep a model, set `NANOCLAW_DEFAULT_MODEL` in `.env` or run `ncl groups config update --id <group> --model <model>` before updating.
- **Codex groups with no model set start new threads on `gpt-6-astra`.** `/add-codex` now pins `@openai/codex` 0.155.1, whose default replaces 0.146.0's `gpt-5.6-sol`; existing threads keep the model they started on. To stay on the old model, run `ncl groups config update --id <group-id> --model gpt-5.6-sol`, then `ncl groups restart --id <group-id>`. `NANOCLAW_DEFAULT_MODEL` would also hold it but applies to Claude groups too. Existing Codex installs get the new pin and the provider fix below together from `/update-nanoclaw`, which rebuilds the agent image on installs that build their own.
- **Claude agents default to a concise tone.** A Claude group whose settings do not set an output style now starts with `Concise`; the default is written once into the group's Claude settings and an explicit value is never overwritten, so groups that already set `outputStyle` are unaffected. To keep or change the tone, set `outputStyle` in `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json` (the group's `/home/node/.claude/settings.json`); project and local settings still take precedence.
- **Existing OpenCode installs must refresh the skill payload.** The optional `/add-opencode` skill now uses the native provider contracts and the new contract refuses the old payload: re-run `/add-opencode`, rebuild the agent image, and restart the host and the OpenCode groups.
- **Cutover stops this install's agent containers itself.** `/update-nanoclaw` no longer times out while an idle agent container is running: it stops the containers with a 10-second grace inside a one-minute bound and names them as it goes, so no manual `docker stop` is needed. An agent in the middle of a turn loses that turn, as with `ncl groups restart`.

### ✨ New

- **Iron Proxy is an alternative local gateway.** `/add-iron-proxy` installs Iron Proxy and its Iron Control web console (Secrets, Credentials, OAuth Apps, Principals) on Docker; each request passes front identity and allowlist, then human approval, then stored credentials, before it reaches upstream. Codex works through Iron, including its WebSocket turns, setup can install Codex and pair it under Iron in one run, and a failed credential save names its cause on screen and in `logs/setup.log`. See [.claude/skills/add-iron-proxy/SKILL.md](.claude/skills/add-iron-proxy/SKILL.md).
- **OpenCode can authenticate through Iron Control.** It can store API keys and native ChatGPT OAuth credentials there, including token refresh and reauthentication that preserves grants.
- **Echo's hardened image and a managed Slack app are set up through the community portal with one browser sign-in.** Setup prints one link that covers sign-in, terminal approval and the perk choice, and the install token never passes through the browser. The running host stays linked to your account's cell, so a perk changed in the browser reaches the running agent and a Slack install approved days later finishes on its own. Setup asks each portal question once, including across a resumed or repeated run; Dial and Tavily are not offered. See [docs/community-portal.md](docs/community-portal.md).
- **Two install-wide model knobs.** `NANOCLAW_DEFAULT_MODEL` fills in the model for agent groups that have not set one of their own (a group's own model always wins), and `NANOCLAW_FAST_MODE=1` turns on the API's fast serving tier for every agent, with faster output at a higher per-token price. Both are read from the host `.env` when container.json is materialized, so a change takes effect at the next container start with no host restart. Installs that set neither are unaffected: neither field is written to container.json and the provider sends exactly the options it sent before.
- **Per-group serving speed.** `ncl groups config update --id <group> --speed fast` selects a serving tier the group's provider declares; Claude accepts `standard` and `fast`, fast mode costs more per token, and `--speed ""` clears it. Agent callers need approval, as with `--timezone`.
- **Agents run on Claude Code 2.1.280.** A `cd` now carries over between turns, Monitor watches expire after 30 minutes, resumed agents keep seeing their current name and destinations, and claude.ai account skills and plugins are not synced into agent containers.
- **The OpenCode provider is reworked.** `/add-opencode` now uses host-managed authentication and model selection, native tools and compaction, and reliable cancellation, and setup can install and authenticate it.
- **Mattermost is a channel.** `/add-mattermost` installs it, can connect to a server you already run, validates and atomically saves its settings, verifies the running bot and server callback, and no longer needs a separately installed `jq`.
- **Host restarts keep approvals and delivery state.** Approvals, delivery retry counts and session claims now live in the central database instead of host memory: an approval card sent before a restart still resolves after it (a late approve that can no longer be applied gets a follow-up card), overdue approvals expire as "no response" instead of being swept as "host restarted", and a message that keeps failing gives up after its retry limit even across a crash loop. A second host started in the same checkout no longer takes over a running host's `ncl` socket, and a host still draining during a restart keeps its sessions until it exits.
- **`ncl status` shows the running host process and its connected channel adapters.** Setup uses it to confirm that the restarted host is the one it started.
- **The Slack agents companion skills ship on `main`.** `/slack-a2a-rooms` and `/slack-agent-flow` now come with the core source.

### 🛠️ Fixes

- **Codex turns no longer complete with nothing sent.** From 0.147.0, Codex starts a turn after about one second without the tools of any MCP server still starting. The provider now waits for every MCP server to finish starting (Codex gives up on one after 30 seconds, as 0.146.0 did) and requires NanoClaw's own tool server: if that server cannot start, the message fails with an error instead of running without its tools.
- **Replies stay in the thread they answer.** Replies, `send_message`, `send_file`, `ask_user_question` and `send_card` land in the thread of the message being answered, not the main channel or a thread that spoke more recently; this covers shared and agent-shared sessions, and replies from a turn longer than 30 minutes stay threaded.
- **Busy installs stay fast.** The host sweep and delivery polls visit up to 8 sessions at a time at a fixed rate, and cross-session ambient context fans out only to a conversation's 8 most recently active threads (within 3 days) after the container wakes, so installs with many sessions or busy channels no longer see reply and task latency grow with size.
- **Quoted `.env` values read the same everywhere.** Setup had its own parser that did not strip surrounding quotes, so a hand-edited `TZ="America/New_York"` or `NANOCLAW_TEMPLATE_PATH="/opt/my templates"` reached the wizard with the quotes attached and the template path was bridged into `process.env` unusable; both readers now share the host parser (`envValue` in `src/env.ts`, the single-key form of `readEnvFile`).
- **`/update-nanoclaw` loads its controller again.** It crashed with `MODULE_NOT_FOUND`; it now also snapshots symlinked data roots by content and is correct on macOS hosts.
- **Setup is sturdier on Linux.** No hang with a system-wide Node, a user-owned npm prefix instead of an invisible sudo, a nohup-started host verified and kept running when user systemd is missing, installers that run under `/bin/sh` and `/bin/bash`, a uvx-installed pnpm recovered, and the replacement host verified after a restart.
- **Concurrent SQLite migrations no longer fail setup or upgrade.** Failed registry copies keep existing files, registry skills install from single-branch clones, and installing missing skill files keeps your customizations.
- **OneCLI certificate and credential-stub mounts survive host restarts and temp cleanup**, and `WEBHOOK_PORT` is read from `.env`.
- **Conversations reach the right place and stop when asked.** Cancelled questions stop promptly, failed provider turns keep partial replies, scheduled-task escalations default to the agent's own channel, and Slack group-DM and multi-instance approval cards name the right conversation and bot.
- **Task failures are easier to diagnose.** `ncl tasks update` rejects an empty `--prompt`, and a timed-out pre-task script says so.
- **`/add-dial` handles more starting states.** It installs the Dial tool on a first-ever install (before any agent exists), echoes what you type at its agent-scope question, and `/add-dial-tool` can re-register a rotated key with OneCLI.
- **Agents know their card options.** They are told that `send_card` supports URL link buttons and that interactive choices need `ask_user_question`.

### 🔒 Security

- **Setup redacts resolved secrets in skill logs** and commits related `.env` values atomically.
- **The agent image is repinned and the supply-chain gate is enforced.** The image is `hardened-2026-08-24` and runs Bun 1.4.0, and pnpm's 3-day `minimumReleaseAge` gate now takes effect. See [docs/hardened-image.md](docs/hardened-image.md).

### 🔧 For custom installations

- **Chat SDK channels can recover content the adapter left in the raw payload.** The bridge drops `message.raw` before persisting, so anything a platform did not project into its message text was lost; Slack keeps pasted tables in `attachments[].blocks[]`, and an agent saw only the sentence before the table. The optional `extractRawText` hook on `ChatSdkBridgeConfig` lets a channel rescue that content as text before raw is discarded; raw payloads still never reach the database, and a channel without the hook is unaffected. Slack uses it to recover pasted tables: refresh `/add-slack` to get it.
- **Custom OpenCode models can declare their limits.** `/add-opencode` documents `OPENCODE_MODEL_CONTEXT_LIMIT`, `OPENCODE_MODEL_OUTPUT_LIMIT` and `OPENCODE_MODEL_INPUT_MODALITIES`, which set a custom model's context, output and input limits.

## [2.3.0] - 2026-08-24

- [BREAKING] **A new Slack experience — per-agent provisioned Slack apps, agent spawning from Slack, and UX improvements — is available to classic single-bot Slack installs.** Classic Slack keeps working unchanged; this gate asks for a decision, not a forced migration. New installs and non-Slack installs are unaffected. **Migration:** run `/migrate-slack-agents` — it detects classic state (exits cleanly otherwise) and either walks the upgrade or records the choice to stay on classic; both outcomes satisfy this requirement.
- **`/add-codex` now pins `@openai/codex` 0.146.0.** The previous pin (0.138.0) defaults to GPT-5.4, which OpenAI retires from Codex on 2026-08-31 — codex-provider agents ride the CLI default model, so stock installs stop completing turns at retirement — and it rejects the newer GPT-5.6 models with a 400 asking for a newer Codex CLI. Re-running `/add-codex` does not re-pin an existing codex install (the manifest merge is keyed on package name); `/update-nanoclaw` does: it refreshes the entry in `container/cli-tools.json` and, on installs that build their own agent image, rebuilds it.
- [BREAKING] **Agent mailbox access now goes through storage-neutral host and runner registries.** The built-in SQLite implementation preserves existing session data and runtime behavior, but custom source may need to replace raw session-database access, await mailbox writes, update moved runner state/heartbeat helpers, drop `DeliveryActionHandler`'s database argument, use booleans for `trigger`/`onWake`, and use the closed inbound-kind set. **Migration:** follow [the agent mailbox seam migration guide](docs/agent-mailbox-seam-migration.md) for the complete detect grep, old→new symbol map, verification, and rollback.
- **Scheduled-task lifecycle semantics are stricter.** Deleting an isolated task cascades its session state, updates refuse already-due runs, recurring selection uses the active series snapshot, and generated task timestamps retain millisecond precision.
- [BREAKING] **The container runtime moves behind the session driver seam.** Session containers are composed as a validated, admission-checked spec and realized by a selectable driver (`src/drivers/`; Docker ships built-in and stays the default). Three surfaces break: **(1) group folder names** align to the runtime label grammar — at most 63 characters of `[A-Za-z0-9_-]`, alphanumeric at both ends — so previously-legal 64-character names, trailing `-`/`_`, and unvalidated legacy imports refuse to spawn; **(2) container names and invocation** change from `nanoclaw-v2-<folder>-<timestamp>` to key-derived `ncl-…` names (the old human-readable name survives as the `nanoclaw-container-name` label) and from `docker run` to `create` + `start --attach` — name-based tooling, Docker-command allowlists, wrappers, and audit rules should match by label instead (`docker ps --filter label=nanoclaw-session`, or `--filter label=nanoclaw-group-folder=<folder>`); **(3) internal container helpers moved** into the driver module — customized installs importing `hostGatewayArgs`, `readonlyMountArgs`, `stopContainer`, `ensureContainerRuntimeRunning`, `cleanupOrphans`, or patching `buildContainerArgs` stop compiling. The `use-native-credential-proxy` skill is retired: the spec's admission rules refuse credential values in container env on every lane, by design — credentials ride the OneCLI vault, and custom Anthropic endpoints use the `ANTHROPIC_BASE_URL` + placeholder-token pattern from setup. **Migration:** run `bun scripts/detect-driver-migration.ts` — it detects all three surfaces in your install and prints one finding per line with a minimal fix instruction; hand the output to your coding agent. Nothing detected means nothing to do.
- **Host restarts now adopt running sessions instead of restarting them.** A service restart no longer kills in-flight agent work; to apply image or runtime changes to a group, restart it deliberately with `ncl groups restart`. Pre-seam containers (spawned before this release) cannot be adopted and are removed at first upgraded startup, exactly as the old startup cleanup did.
- **Container gateway wiring is typed and admission-checked.** The gateway's per-session contribution (proxy env, trust anchors, credential-stub mounts) merges into the session spec before validation instead of riding raw docker flags around it, and gateway selection becomes a registry (`NANOCLAW_GATEWAY_PROVIDER`, default `onecli` — an install that never sets it behaves as it always has).
- **Non-root hosts get an explicit container identity.** Every non-root host now passes `--user <uid>:<gid>` and `HOME=/home/node` (previously uid-1000 hosts relied on the image's `node` user). On uid-1000 systems whose primary gid is not 1000, files the agent writes into mounted workspaces now carry the host's gid — which is the intended behavior.
- **`CONTAINER_MEMORY_LIMIT` is validated at spawn.** Invalid values refuse the spawn with a named error instead of surfacing as a raw Docker error; blank and `0` still mean uncapped.
- **An unknown `NANOCLAW_RUNTIME_DRIVER` aborts startup** (new variable — installs that never set it are unaffected), and drivers that cannot rebuild images in place deny `install_packages` and `--rebuild` at request time instead of failing later.
- [BREAKING] **The host runtime now requires Node.js 22 or newer.** Node 20 is not supported by the upgraded `better-sqlite3` release used for current Node runtimes. **Migration:** run `bash setup/install-node.sh`, verify `node --version` reports v22 or newer, then rerun `/update-nanoclaw`; stay on the previous NanoClaw release if Node cannot yet be upgraded.
- **New NanoClaw installs now use OneCLI gateway 1.41.0.** Existing 1.36.0 gateways remain compatible because NanoClaw does not depend on any 1.41-only behavior. See [the OneCLI upgrade guide](docs/onecli-upgrades.md) to upgrade an existing gateway.
- [BREAKING] **Central database access is now asynchronous behind `DbDriver`.** SQLite remains the default and existing `data/v2.db` files are unchanged, but custom source and installed channel/provider extensions must await central reads and writes and adopt the retyped host seams. **Migration:** follow [the central database async migration guide](docs/central-db-async-migration.md) to find affected calls, preserve transaction boundaries, update extensions, verify SQLite behavior, or roll back.
- **Central DB composition and migrations are backend-ready.** A one-slot driver registry keeps backend selection in `src/db/compose.ts`; `pnpm run migrate` is the explicit schema-change path, host validation can fail closed without DDL, and a shared conformance suite pins transaction, parameter, ordering, and timestamp behavior. SQLite remains the installed default.

## [2.2.0] - 2026-08-13

- **Stamped plugins update in place through `ncl groups create --template <ref>`.** When a group already carries the template's plugin, the same command becomes an in-place update instead of minting a duplicate agent: a dry run prints a plan of every plugin-owned surface (plugin files, skills, MCP servers, persona, context files, tasks), flagging locally customized files whose edits would be lost; `--yes` applies, `--id` picks among several stamped groups, `--new` deliberately stamps another agent. Agent state the plugin does not own (memory, `plugin-data/`, user-added MCP servers, task pause/resume state, wiring) is never touched. Plugin-stamped MCP servers now carry an ownership marker and refuse direct edits via `ncl groups config add-mcp-server` / `remove-mcp-server` or the agent's `add_mcp_server` tool: update the plugin and restamp instead.
- [BREAKING] **Agent templates are now Agent Plugins 1.0.0 directories.** `plugin.json` replaces `context/instructions.md` as the required file; MCP servers move to a spec-shaped `mcp.json`; persona, extra context, and tasks move under the `ai.nanoco.nanoclaw/` extension dir. Templates become portable to other plugin clients, and any conformant third-party plugin stamps as a NanoClaw agent. **Migration:** re-fetch templates from the registry (the pre-plugin layout fails with a migration error); to convert a local custom template, see [docs/templates.md](docs/templates.md).
- **Plugin MCP servers may declare a working directory.** `cwd` in `mcp.json` (fixed forms `./p`, `${PLUGIN_ROOT}[/p]`, `${PLUGIN_DATA}[/p]`) now launches the server in that directory instead of being skipped: resolved to an absolute container path at runtime, consumed natively by providers that support it and via a `cd`-then-`exec` launch shim on Claude. A stdio server that omits `cwd` runs from the plugin root (the spec default).
- **Setup can stamp the first agent from a template.** The wizard offers the NanoClaw template library (or local `templates/`) when creating the first agent; `--template-path <ref>` or the advanced screen presets the pick. A rerun over a partial install updates the stamped agent in place (dry-run plan + confirm) instead of duplicating it, the pick persists across wizard re-execs and reruns, and a template failure warns and continues instead of aborting setup.
- **Remote MCP servers can use Streamable HTTP.** Register them with `ncl groups config add-mcp-server --name <name> --url <url>` or the existing admin-approved `add_mcp_server` tool. Local stdio MCP commands keep their current `command` / `args` / `env` behavior; remote credentials remain OneCLI-managed: URLs with userinfo, fragments, or credential-looking query parameters are rejected. HTTPS is required except for `localhost` / `host.docker.internal`.
- [BREAKING] **Host modules now use one lifecycle registry.** Custom modules that import `onShutdown()` or `getShutdownCallbacks()` from `response-registry.ts` must move to the host lifecycle API. **Migration:** follow [the host lifecycle migration guide](docs/host-lifecycle-migration.md) to detect affected code, update it, verify the cutover, or roll back.
- **Agent-to-agent messaging no longer loses to Claude Code's built-in `SendMessage`.** That built-in addresses the SDK's own in-session subagents, so an agent that had just run `create_agent` reached for it by name and got `No agent named 'x' is currently addressable` — reading as "the group was never provisioned" while `mcp__nanoclaw__send_message` (the real path) was never called. `SendMessage` joins `AskUserQuestion` in `SDK_DISALLOWED_TOOLS`, so the PreToolUse hook now blocks it and points at the nanoclaw equivalent.
- **Security: agent-image toolchains bumped past a critical `tar` vulnerability (GHSA-23hp-3jrh-7fpw).** pnpm moves to 10.34.5 (host `packageManager` and container `PNPM_VERSION` in lockstep) and the container pins npm 10.9.9 over the base image's 10.9.8, replacing the vulnerable vendored `tar` in both. Rebuild the agent image to pick it up; no behavior change.
- [BREAKING] **Existing Claude installs should review the hardened agent image.** Local builds remain supported, but the Echo-built image is recommended for patched sandbox components. **Migration:** follow [the hardened-image guide](docs/hardened-image.md) to detect your current image source, switch, verify, or roll back.
- **Release publication tolerates GitHub API propagation.** The Release workflow now retries bounded post-publication read-backs when the new Release is not listed yet or its immutable state is not visible yet. Exact title, body, tag, or SHA mismatches still fail immediately.
- The `add-tavily-tool` skill adds Tavily Search and Extract as keyless remote MCP tools for selected agent groups, bridged through a pinned `mcp-remote`.
- Scheduled tasks now run with their effective scheduled occurrence as the task time, plus a task-only `current_time` (weekday included, in the agent group's timezone) instead of the creation timestamp.
- Accumulated messages stay available as context without spuriously triggering warm-container follow-up turns; group-scoped agents can inspect their wirings and request approved engagement-policy updates; invalid engagement regexes are rejected.
- Hosted iMessage setup now provisions the line's user row directly and prints the assigned number to text once; that first message is the opt-in the delivery plane checks, and re-runs reuse the existing row.
- Resolved approval cards keep their title and request details, replace buttons with the decision and actor (or a timeout status), and survive host restarts and delayed resolution.
- Setup failure assist now offers diagnosis through the provider the operator picked instead of always offering to install Claude.
- `ensureUserDm` gains an opt-in privacy-safe logging mode for security-sensitive flows: user IDs, handles, messaging-group IDs, and raw adapter errors are omitted while non-identifying channel context is kept.
- The stale `add-gcal-tool`, `add-gmail-tool`, and `get-qodo-rules` skills were removed.
- The recommended hardened agent image is repinned to `hardened-2026-08-13`.
- The package description now says personal AI assistant: NanoClaw is provider-agnostic, not Claude-only.
- Docs: skills define a single-responsibility integration rule, and the hardened-image guide states that `install_packages` covers apt and npm packages only.

## [2.1.54] - 2026-08-01

Rollup release covering v2.1.18 through v2.1.54 — everything merged since the v2.1.17 tag.

- [BREAKING] **iMessage unified into one `imessage` channel with two backends via `/add-imessage`:** Local (this Mac's `chat.db` via the Chat SDK) or Hosted (native [Photon](https://photon.codes) via `spectrum-ts`, no Mac relay). Backend chosen at install or via `IMESSAGE_BACKEND=local|hosted`. The legacy Chat-SDK remote mode (`IMESSAGE_SERVER_URL`/`IMESSAGE_API_KEY`) and the separate `imessage-cloud` channel + `/add-imessage-cloud` skill are **removed**. See [docs/imessage.md](.claude/skills/add-imessage/docs.md).
- [BREAKING] **Provider-agnostic memory.** All providers now share one OKF v0.1-compatible `memory/` tree, while persona lives in `instructions.prepend.md`; startup, clear, and compact reload memory automatically. Existing groups with legacy memory must run `/migrate-memory` before use. See [memory](docs/memory.md) and [provider migration](docs/provider-migration.md).
- **New groups can inherit an instance-wide default provider.** `DEFAULT_AGENT_PROVIDER` sets the provider used when a new agent group is created without an explicit provider. Each group's stored provider still overrides it, and existing groups are unchanged.
- [BREAKING] **Channel install skills are now the single source of truth.** The setup wizard installs channels by applying the same `/add-<channel>` SKILL.md a coding agent would follow — a deterministic engine executes the skill's mechanical steps directly from the document, so wizard and skill cannot drift, and anything the engine cannot do falls back to an agent reading the prose. **Migration:** the bespoke non-interactive channel installers (`setup/add-<channel>.sh`, `setup/install-<channel>.sh`) and per-channel wizard flows (`setup/channels/<channel>.ts`) are deleted. Anything that invoked them should apply the skill instead: interactively via `/add-<channel>` or the setup wizard, or programmatically via [skill directives](docs/skill-directives.md).
- **One guard for privileged actions.** Every privileged action crossing the container or channel boundary now passes through `guard()` before execution: `allow`, `hold`, or `deny`. Approved replays carry the approval row as a grant and re-run checks against current state; forged, consumed, mismatched, or newly unauthorized grants fail closed. Guarded delivery actions can no longer be re-registered without their guard specification.
- [BREAKING] **`whatsapp-formatting` and `slack-formatting` moved from trunk to the `channels` branch.** They now install with their channel, so installations without those channels no longer carry channel-specific formatting instructions in every agent's context. **Migration — only if the channel is installed:** re-run `/add-whatsapp` or `/add-slack` after updating. Do not run an add-skill preemptively; it installs the full adapter.
- [BREAKING] **Scheduled tasks moved from MCP tools to `ncl tasks`.** Agents and operators now manage tasks with `ncl tasks list/get/create/update/cancel/pause/resume/delete/run/append-log`; task sessions are isolated from the chat session that created them. **Migration:** follow [the scheduled-task migration guide](docs/ncl-tasks-migration.md).
- [BREAKING] **Task delivery is explicit and uses one door.** Every `send_message` and `send_file` call requires a named `to` destination; task-session final output becomes the run summary, while only explicitly addressed tool calls deliver. **Migration:** rebuild the agent image, restart NanoClaw, update custom instructions that omit `to`, and clear or compact existing sessions. Failed pre-task scripts now back their recurring series off and auto-pause after eight consecutive failures instead of spinning.
- [BREAKING] **Chat SDK and channel adapters are pinned to `4.29.0`.** The bridge and adapter must use the same `ChatInstance` type, so exact pins replace caret ranges. Core installations without a channel are unaffected. **Migration:** if a channel is installed, re-run its `/add-<channel>` skill after updating.
- **Hardened agent images are available as an opt-in setup path.** A digest-pinned, multi-architecture image can be fetched from the NanoClaw registry and retagged to the same local name used by builds; architecture, lockfile, provenance, size, and optional publisher-signature checks fail closed. Local builds remain the default and require no account. See [hardened images](docs/hardened-image.md).
- **Agent containers now start with safer defaults.** New spawns always drop all Linux capabilities, set `no-new-privileges`, and use Docker's init process; these controls have no per-group override. A PID limit defaults to 2048 and can be changed installation-wide with `CONTAINER_PIDS_LIMIT` (`0` disables it). The Vercel CLI is now opt-in instead of being baked into every image.
- **Agent containers can have installation-wide resource caps.** `CONTAINER_CPU_LIMIT` and `CONTAINER_MEMORY_LIMIT` pass `--cpus` and `--memory` to Docker for every agent container. Both remain empty by default, so existing installations keep their current behavior.
- **Per-agent-group timezones.** `ncl groups config update --timezone <IANA>` overrides the install timezone for that group's scheduling, run-log display, and container `TZ`; `""` clears the override. Host-side operator display remains in the install timezone.
- **Agent templates and reusable skills expanded.** Local templates can stamp persona, context, MCP configuration, and skills through `ncl groups create --template`; templates can also seed scheduled tasks and timezone. `/learn` distills a reusable skill from an existing workflow, and `/add-clidash` installs a read-only CLI-derived dashboard.
- **A clearer, safer `ncl` control plane.** Verbs now declare and validate their arguments, generate deep help, preserve dashed IDs, render human-readable output on the host, and flush large responses before exit. Creating groups and wirings now provisions their required companion rows transactionally, fixing first-spawn failures and silently dropped replies.
- **Approval and agent-to-agent controls are more expressive.** Connected agents can require per-message approval; rejection reasons reach the requester; OneCLI approval cards use the gateway's structured summary; and shared-channel cards retain who approved or rejected an action.
- **Delivery and provider failures stop disappearing.** Missing adapters route messages into retry instead of marking them delivered, agent image builds no longer block the host, and Claude rate-limit telemetry only aborts a turn when the SDK reports a rejection. Billing exhaustion and transient rate limits remain distinct.
- **Setup and update recovery improved.** Setup can parse wrapped Claude OAuth captures, offer Slack Socket Mode, and reap dead peer-service registrations. Re-applying an updated skill rebuilds the container when needed, and a missing session folder is re-provisioned so the documented reset path works.
- **Security fixes.** Inbox attachment writes reject symlink escapes, approved CLI calls preserve the original caller context, command-gate checks no longer fail open, mount allowlists honor `readOnly`, and stale v1 secret/config mirrors were removed.
- Documentation was refreshed across architecture, database schemas, security boundaries, provider configuration, SDK behavior, skills, and registry-branch maintenance. A Korean README is now available.

## [2.1.17] - 2026-06-17

Rollup release covering v2.1.1 through v2.1.17 — every `package.json` bump merged since the v2.1.0 tag. This section restores the changelog entry from the already-published [v2.1.17 GitHub Release](https://github.com/nanocoai/nanoclaw/releases/tag/v2.1.17).

- [BREAKING] **`@onecli-sh/sdk` 0.5.0 → 2.2.1 requires a OneCLI server with the `/v1` API.** Older servers return 404 for every SDK call. The sanctioned gateway and CLI versions are pinned in `versions.json`, and the `onecli` setup step enforces them. **Migration:** `/update-nanoclaw` upgrades the gateway when its pin moves; otherwise follow [the OneCLI upgrade guide](docs/onecli-upgrades.md).
- **New Codex agent provider.** Run `/add-codex` to install the `codex app-server` provider from the `providers` branch. Authentication remains vault-only; no credential enters a container.
- **Setup can select, install, and authenticate a non-default agent provider.** The selected provider is stored on the first agent before its first spawn. Picking the default Claude provider changes nothing.
- **Provider choice is explicit per group.** Change it with `ncl groups config update --provider`, then restart the group.
- **Provider memory moves through `/migrate-memory`.** Runtime does not copy provider-owned stores automatically; follow [the provider migration guide](docs/provider-migration.md).
- **`/update-nanoclaw` upgrades the OneCLI gateway when its sanctioned pin moves.** Hosts whose gateway pin did not change are unaffected.
- **Budget and billing errors reach the user.** Non-retryable provider errors without message wrapping are delivered to the originating channel instead of entering a silent retry loop.
- **Command-gate denials reach the sender.** Host-side outbound writes now use the read-write opener, fixing a `SQLITE_READONLY` failure that silently dropped denial responses.
- **Slash commands interrupt an in-flight turn.** Runner-handled commands such as `/clear`, `/compact`, and `/cost` no longer wait for the current turn to finish.
- **Container boot failures say why.** A stderr tail is logged at warning level when a container exits non-zero instead of disappearing below the default log level.
- **Opt-in egress lockdown.** Containers can fail closed against a configured outbound allowlist. See [the security model](docs/SECURITY.md#5-egress-lockdown-forced-proxy).
- **Channel instances are first-class.** One channel kind can run multiple independent instances with separate credentials, Chat SDK state, and webhook routes; existing single-instance installs remain compatible.
- **Native uninstaller.** `bash uninstall.sh` or `nanoclaw.sh --uninstall` removes the service, data directory, host registration, and OneCLI agent registration for that installation. Dry-run and confirmation modes are included.
- **Interactive setup handoffs preserve context.** Failure and `?` handoffs now provide the context as Claude's first user prompt and retain one session across handoffs.
- **Raw webhook route registry.** Channels can register HTTP routes without editing the host route table.
- **Typed delivery-action and approval-resolved registries.** Channels can expose delivery actions and receive approval-resolution callbacks without channel-specific branching at the host call site.
- **Provider-owned per-exchange archiving.** The agent runner exposes `onExchangeComplete`; providers opt into their own archival behavior.
- [security] **A2A attachment resolution rejects symlink escapes** from the per-group sandbox.
- [security] **Approval responses require an authorized admin** whose scope covers the request's group.
- [security] **Agent creation is authorized on the host** as well as the API edge; confined groups require host-side approval.
- `host-sweep` respects a per-group wake grace instead of tearing down a container that just woke with a stale processing claim.
- Global container CLI installs are data-driven through `container/cli-tools.json`; `agent-browser` is pinned to `0.27.1`.
- Four v1-only skills were retired: `claw`, `x-integration`, `add-parallel`, and `convert-to-apple-container`.
- The skills installation model is documented in [the skills model](docs/skills-model.md), and twelve skills were updated to the current contract.
- An Ollama prompt-cache guide was added for the Claude Code → Ollama path. See [Ollama](docs/ollama.md).
- Resolved approval and question cards in shared channels retain the acting user's name.
- `@anthropic-ai/claude-code` and `@anthropic-ai/claude-agent-sdk` were updated to `2.1.170` and `0.3.170`.

## [2.1.0] - 2026-06-07

- [BREAKING] **Startup now requires an upgrade marker.** The host refuses to boot unless `data/upgrade-state.json` records that this install reached the current version through a sanctioned path (`/setup`, `/update-nanoclaw`, `/migrate-nanoclaw`). After this update completes — and before restarting the service — stamp the marker by running `pnpm exec tsx scripts/upgrade-state.ts set`. If the host has already tripped on restart with "update did not go through the supported path", that same command clears it. See [docs/upgrade-recovery.md](docs/upgrade-recovery.md).

## [2.0.64] - 2026-05-18

- **`ncl destinations add` and `remove` through the approval flow now reach the receiver immediately.** Approved destinations weren't being projected into the receiving agent's local session state, so a freshly-added destination silently failed at `send_message` with `unknown destination`, and a removed destination stayed resolvable until the next container restart. Both now take effect the moment the approval executes. Direct (non-approval) calls were unaffected.

## [2.0.63] - 2026-05-15

Rollup release covering v2.0.55 through v2.0.63 — everything merged since the v2.0.54 tag. Starting with this release, the goal is to publish a GitHub Release for every `package.json` version bump that lands on `main`; see [RELEASING.md](RELEASING.md).

- [BREAKING] **Service names are now per-install.** On v2 installs the launchd label and systemd unit are slugged to your project root: `com.nanoclaw.<sha1(projectRoot)[:8]>` and `nanoclaw-<slug>.service`. The old `com.nanoclaw` / `nanoclaw.service` names no longer match a real service — update any copy-pasted restart or status commands. Find your install's names with `source setup/lib/install-slug.sh && launchd_label` (macOS) or `systemd_unit` (Linux). The `ncl` transport-error help text and 26 skill files now use the canonical helper-driven pattern; see [setup/lib/install-slug.sh](setup/lib/install-slug.sh).
- **Compaction destination reminder placement fixed.** The reminder injected after SDK auto-compaction now appears at the end of the compaction summary so it isn't stripped during truncation. Replaces the placement shipped in v2.0.54.
- **Stronger message-wrapping enforcement.** The poll loop nudges the agent when its output lacks `<message>` wrapping, and `CLAUDE.md` core instructions now require wrapping even for single-destination agents. The welcome flow no longer double-greets.
- **OneCLI credentials after MCP install.** MCP servers added through `add_mcp_server` now inherit OneCLI gateway routing — fixes the case where the agent kept asking for API keys after installing a new server.
- **CLI scope hardening.** `scopeField` now fails closed when scope is missing, and `sessions get` is guarded against cross-group oracle access from group-scoped agents.
- **gmail/gcal skills aligned with v2.** `/add-gmail-tool` and `/add-gcal-tool` now reflect the v2 container-config model — DB-backed mounts, no dead `TOOL_ALLOWLIST` edits, no `container.json` writes that get clobbered on next spawn. Manual sqlite3/JSON1 invocations corrected.
- **Repo-rename cleanup.** Remaining `qwibitai/nanoclaw` references swept to `nanocoai/nanoclaw` across code and docs; CI workflow guards updated so they no longer no-op after the rename.
- Slack scope checklist now includes `files:read` and `files:write` for skills that read or post attachments.
- The internal-tag description in destination instructions no longer mentions scratchpads (which confused agents into routing them incorrectly).
- Container startup is now graceful when the `on_wake` column is missing on older sessions DBs.

## [2.0.54] - 2026-05-10

- **Per-group model and effort overrides.** Agent groups can now run a specific Claude model and effort level, set via `ncl groups config update --model <model> --effort <level>`. Defaults to the host-configured model when unset.
- **Claude Code 2.1.128.** Container claude-code bumped from 2.1.116 to 2.1.128.
- CLI help text improvements for `ncl groups config` and `ncl groups restart`.

## [2.0.48] - 2026-05-09

- **Container config moved to DB.** Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, skills) now lives in the `container_configs` table instead of `groups/<folder>/container.json`. Existing filesystem configs are backfilled automatically on startup. Managed via `ncl groups config get/update` and `config add-mcp-server/remove-mcp-server/add-package/remove-package`.
- **Explicit restart with on-wake messages.** Config CLI operations no longer auto-kill containers. New `ncl groups restart` command with `--rebuild` and `--message` flags. On-wake messages (`on_wake` column on `messages_in`) are only picked up by a fresh container's first poll, preventing dying containers from stealing them during the SIGTERM grace period. Self-mod approval handlers (`install_packages`, `add_mcp_server`) use the same race-free mechanism.
- **Per-group CLI scope.** New `cli_scope` setting on container config (`disabled` / `group` / `global`, default `group`). Controls what the agent can access via `ncl` from inside the container. `disabled` excludes CLI instructions from CLAUDE.md and blocks all requests. `group` (default) restricts to own-group resources with auto-filled args. `global` gives unrestricted access (set automatically for owner agent groups). Includes post-handler result filtering to prevent cross-group data leaks and blocks `cli_scope` escalation from group-scoped agents.

## [2.0.45] - 2026-05-08

- **Admin CLI (`ncl`).** New `ncl` command for querying and modifying the central DB — agent groups, messaging groups, wirings, users, roles, members, destinations, sessions, approvals, and dropped messages. Host-side transport via Unix socket; container-side transport via session DB. Write operations from inside containers go through the approval flow. `list` supports column filtering and `--limit`. Run `ncl help` for usage.
- **v1 → v2 migration.** Run `bash migrate-v2.sh` from the v2 checkout. Finds your v1 install (sibling directory or `NANOCLAW_V1_PATH`), merges `.env`, seeds the v2 DB from `registered_groups`, copies group folders (`CLAUDE.md` → `CLAUDE.local.md`), copies session data with conversation continuity, ports scheduled tasks, interactively selects and installs channels (clack multiselect), copies container skills, builds the agent container, and offers a service switchover to test. Hands off to Claude (`/migrate-from-v1`) for owner seeding, access policy, CLAUDE.md cleanup, and fork customization porting. See [docs/migration-dev.md](docs/migration-dev.md) and [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md).

## [2.0.0] - 2026-04-22

Major version. NanoClaw v2 is a substantial architectural rewrite. Existing forks should run `/migrate-nanoclaw` (clean-base replay of customizations) or `/update-nanoclaw` (selective cherry-pick) before resuming work.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
