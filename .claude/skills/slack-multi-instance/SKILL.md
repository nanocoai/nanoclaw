---
name: slack-multi-instance
description: Run N Slack bot identities in one workspace via SLACK_INSTANCES — each name gets its own slack-<name> adapter instance built from a per-instance token set, sharing channelType, formatting, and wiring defaults with the default Slack app. Documentation only — the registration is native to the installed Slack adapter.
---

# Slack multi-instance (SLACK_INSTANCES)

One NanoClaw host can run **several Slack apps in one workspace**, each with
its own bot identity. There is nothing to install: the Slack adapter
(`src/channels/slack.ts`, installed by `/add-slack`) reads
`SLACK_INSTANCES=<name>[,<name>…]` from `.env` at load and registers one
additional bridge per listed name under the `slack-<name>` instance key,
built from that name's own token set through the same factory as the default
app. `channelType` stays `slack` — instance is a routing key; user ids,
formatting, container config, and the wiring-defaults declaration are shared
with the default Slack app. This document only records the conventions.

## Configuration

Per named instance `<name>` (listed in `SLACK_INSTANCES`), create a separate
Slack app in the same workspace — same scopes, events, and App Home settings
as the default app (the `/add-slack` walkthrough lists them) — and store its
tokens in `.env` under the suffixed keys. `<NAME>` is the name uppercased
with dashes as underscores (`gh-bot` → `GH_BOT`):

```
SLACK_INSTANCES=dana
SLACK_BOT_TOKEN_DANA=xoxb-…
SLACK_APP_TOKEN_DANA=xapp-…        # Socket Mode (omit for webhook delivery)
SLACK_SIGNING_SECRET_DANA=…        # webhook delivery only
SLACK_WORKSPACE_ID_DANA=T…         # optional workspace pin (see below)
```

Registration is unconditional for every listed name, so a missing token set
surfaces as the registry's "credentials missing, skipping" warning at boot
rather than a silently absent bot.

Tokens are read when the instance starts, through the channel credential
provider (`src/channels/credential-provider.ts`, `.env` by default), so a
rotated token is picked up at the next start. `SLACK_WORKSPACE_ID` (or
`SLACK_WORKSPACE_ID_<NAME>` for one instance) pins an instance to a workspace
(`T…` team id): envelopes from any other workspace are acked and dropped
before they are processed. Unset, every installation's events are processed,
the single-workspace default.

Wire messaging groups to a named instance by setting the messaging group's
`instance` to `slack-<name>`.

## Restart vs hot start

`SLACK_INSTANCES` is read once, at adapter load — after editing `.env` by
hand, restart the service (`bash setup/lib/restart.sh`) so the new instance
registers and connects. The exception is programmatic provisioning: flows
that create agents in-process (the `slack-agent-flow` skill) append the
instance and its tokens to `.env` and then hot-start the new adapter through
the registry's `startChannelAdapter` entry, so those instances come up
without a restart.

## Validation

The channel payload ships the guard for all of this:
`src/channels/slack-instances-registration.test.ts` (installed by
`/add-slack` alongside the adapter) drives the registration loop against a
crafted `.env` and pins the shared wiring-defaults declaration and the
env-key suffix mapping:

```bash
pnpm exec vitest run src/channels/slack-instances-registration.test.ts
```

## Remove

Remove `SLACK_INSTANCES` and any `SLACK_*_<NAME>` token lines from `.env`,
then restart the service. Messaging groups wired to a removed `slack-<name>`
instance stop resolving an adapter until rewired or deleted. (Adapter code is
untouched — the registration loop simply finds no names.)
