# imessage-cloud — native iMessage via Photon

Photon connects NanoClaw to **iMessage** through [Photon][photon] — a managed
service that owns the iMessage line, delivery, and abuse-prevention, so you
don't have to run your own Mac relay. Photon's free tier uses a shared iMessage
line pool, so anyone can get started without a paid plan.

This is a **native channel** installed with `/add-imessage-cloud`: the adapter
(`src/channels/imessage-cloud.ts`) is fetched from the `channels` branch and
self-registers in the channel barrel. It stays dormant until credentials exist.

## Architecture

Like Discord and Slack, Photon is a **persistent-connection** channel — no
public URL, no webhook, no signing secret. The `spectrum-ts` SDK holds a
long-lived **gRPC stream** to Photon for both directions.

NanoClaw's host runs on Node, and `spectrum-ts` is a TypeScript SDK, so the SDK
runs **in-process on the host** — there is no Python sidecar (as in Hermes,
whose gateway is Python) and no loopback HTTP. `deliver()` / `setTyping()` call
the SDK directly; a re-subscribing consumer loop drains the inbound stream.

```
                       gRPC (spectrum-ts, in-process)
┌─────────────────────────┐  ◄───────────────►  ┌──────────────────────────┐
│  Photon Spectrum cloud  │   app.messages       │  NanoClaw host (Node)    │
│  (iMessage line owner)  │   space.send()       │  imessage-cloud.ts       │
└─────────────────────────┘                      └──────────┬───────────────┘
                                        onInbound / deliver  │  ▲
                                                             ▼  │
                                                   router / delivery pipeline
```

- **Inbound** — the SDK's `app.messages` async iterator yields
  `[space, message]` pairs. The adapter normalizes each into an
  `InboundMessage` (text, downloaded attachments, reaction markers) and hands
  it to the router via `onInbound`. If the stream ends or errors, the consumer
  loop re-subscribes with capped exponential backoff.
- **Outbound** — `deliver()` resolves the target space (a DM by phone number
  via `space.create`, or a group by its opaque space id via `space.get`) and
  calls `space.send(markdown | text | attachment | voice | typing | read)`.

## Credentials

Runtime SDK credentials live in `.env` (host-side; **never** enter a
container — delivery is host-side, and the container-runner does not mount
`.env` into agent containers):

```bash
PHOTON_PROJECT_ID=<spectrum project id>   # the SDK's projectId
PHOTON_PROJECT_SECRET=<project secret>
```

The device-login bearer token used during setup is cached in
`data/photon-auth.json` (mode `0600`) so re-running the wizard reuses it.

## Setup

During first-time NanoClaw setup, choose **Yes, connect iMessage (via
photon.codes)**. That path asks for your iMessage phone number, runs the Photon
device login and provisioning wizard, installs the pinned runtime SDK, restarts
NanoClaw, and wires the DM to your first agent. It does not ask for a server
URL or API key.

The `/add-imessage-cloud` skill provides the same flow for an existing installation.
The underlying commands are:

```bash
# 1. install the runtime SDK (pinned — spectrum-ts ships breaking majors)
pnpm install spectrum-ts@8.0.0

# 2. run the setup wizard (device login + auto-provision everything)
pnpm exec tsx scripts/photon-setup.ts --phone +15551234567
```

`scripts/photon-setup.ts` does, in order:

1. **Device login** (RFC 8628, `client_id=photon-cli`) — prints a URL + code,
   opens your browser, and polls until you approve. Talks only to Photon's
   dashboard HTTP API — it does not import `spectrum-ts`, so it works before the
   runtime SDK is installed.
2. **Find or create** the `NanoClaw` project on the Photon dashboard.
3. **Mint the project secret** (the dashboard reveals it once) and write
   `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` to `.env`.
4. **Register your phone** as a Spectrum user (idempotent — skipped if already
   present).
5. **Surface the assigned iMessage line** — the number you text to reach your
   agent.

Everything is idempotent: re-running reuses the stored token/project and only
fills gaps, so it's safe to finish a partial setup. `pnpm exec tsx
scripts/photon-setup.ts status` shows what's configured.

After setup, restart the service so the adapter connects, then text the
surfaced number once and wire the DM to an agent with `/init-first-agent`
(the wizard prints a ready-to-run command).

## Configuration

All optional, set in `.env`:

| Env var                              | Default                         | Meaning                                                                                  |
| ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `PHOTON_PROJECT_ID`                  | — (required)                    | Spectrum project id (SDK `projectId`)                                                    |
| `PHOTON_PROJECT_SECRET`              | — (required)                    | Project secret                                                                           |
| `PHOTON_MARKDOWN`                    | `true`                          | Send agent replies as markdown (iMessage renders it natively). `false` sends plain text. |
| `PHOTON_TELEMETRY`                   | `false`                         | Enable Spectrum SDK telemetry                                                            |
| `PHOTON_MAX_INLINE_ATTACHMENT_BYTES` | `20971520` (20 MB)              | Max inbound attachment size the adapter reads + caches                                   |
| `PHOTON_DASHBOARD_HOST`              | `https://app.photon.codes`      | Dashboard API host (setup wizard)                                                        |
| `PHOTON_SPECTRUM_HOST`               | `https://spectrum.photon.codes` | Spectrum API host (setup wizard)                                                         |

## Platform ids

- **DMs** are direct-addressable: the `platform_id` is the counterpart's bare
  E.164 number (e.g. `+15551234567`), and the user id is `imessage-cloud:+15551234567`.
  No channel prefix (see `src/platform-id.ts`).
- **Groups** use the opaque Spectrum space id, discovered on first message.

## Features

- **Markdown** — replies are sent via the SDK's `markdown()` builder; iMessage
  renders bold/italics/lists/code natively. `PHOTON_MARKDOWN=false` reverts to
  plain text.
- **Inbound attachments & voice notes** — read off the stream and cached to
  `data/attachments/`, surfaced to the agent as structured `attachments` (with
  a `[… could not be downloaded]` note on failure). Over-cap media is skipped.
- **Outbound attachments** — files are written to a temp path and sent via
  `space.send(attachment(...))`.
- **Reactions (tapbacks)** — `send_reaction` maps to an iMessage tapback;
  inbound tapbacks arrive to the agent as `reaction:added:<emoji>`.
- **Read receipts** — each inbound message marks its iMessage chat read via
  `space.send(read(message))`; receipt failures never block inbound routing.
- **Approval questions** — `ask_user_question` renders as text with
  `/approve` / `/reject` slash-command replies (iMessage has no buttons). A
  matching reply routes to the approval handler instead of waking the agent.
- **Typing indicators** — sent while the agent is working.

## Upgrading spectrum-ts

`spectrum-ts` is pinned to an **exact** version in `package.json` because the
SDK ships breaking majors (v8 is what the adapter targets). Upgrades are
deliberate:

1. Read the [SDK release notes][releases] for every version between the current
   pin and the target.
2. Bump the exact pin and run `pnpm install`.
3. Reconcile `src/channels/imessage-cloud.ts` against the new typings. The adapter uses
   `Spectrum`, the `imessage` provider, the `text` / `markdown` / `typing` /
   `read` / `attachment` / `voice` content builders, and `space.send` /
   `space.getMessage` / `message.react`.
4. Run `pnpm run build` and `pnpm exec vitest run src/channels/imessage-cloud.test.ts`.

## Troubleshooting

| Symptom                                 | Fix                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `spectrum-ts is not installed` at setup | `pnpm install spectrum-ts@8.0.0`, then restart                                                                        |
| Device login times out                  | Re-run the wizard (the code expires in ~30 min; a stored token is reused)                                             |
| No iMessage line assigned               | Re-run `… photon-setup.ts status` or check the [dashboard][photon]; the shared line can take a moment                 |
| Inbound stops arriving                  | The adapter re-subscribes automatically; if it persists it's usually upstream — restart to force a fresh stream       |
| Bot silent                              | Check `grep "Photon channel connected" logs/nanoclaw.log`, that the channel is wired, and that the service is running |

Compared to the community `/add-imessage` skill (Photon in "remote mode" via
the Chat SDK bridge), this native adapter talks to Photon directly, supports
outbound attachments and tapbacks, and includes the provisioning wizard.

[photon]: https://photon.codes/
[releases]: https://github.com/photon-hq/spectrum-ts/releases
