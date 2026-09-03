# iMessage — one channel, two backends

NanoClaw connects to **iMessage** through a single `imessage` channel with two
pluggable backends. Pick one at install time (or force it with
`IMESSAGE_BACKEND=local|hosted`); only one runs per install.

- **Local** — the Chat SDK bridge over [`chat-adapter-imessage`][adapter],
  reading **this Mac's** signed-in iMessage account (`chat.db`). macOS only, and
  the Node binary needs Full Disk Access. No third-party service — your messages
  never leave your machine — but NanoClaw must run on the Mac that's signed in.
- **Hosted** — a native adapter connecting to iMessage through [Photon][photon],
  a managed service that owns the iMessage line, delivery, and
  abuse-prevention, so you don't run a Mac relay. Works on any OS. Photon's free
  tier uses a shared iMessage line pool, so anyone can start without a paid plan.

Install either flavor with `/add-imessage` (it asks which backend); the adapter
(`src/channels/imessage.ts`) is fetched from the `channels` branch and
self-registers in the channel barrel. It stays dormant until a backend is
configured.

## Choosing a backend

| | Local | Hosted iMessage (via photon.codes) |
| --- | --- | --- |
| Runs on | macOS only (reads `chat.db`) | any OS |
| iMessage line | your own Apple ID | Photon-managed number |
| Setup | grant Full Disk Access | device-login wizard |
| Package | `chat-adapter-imessage@0.1.1` | `spectrum-ts@11.0.0` |
| Credentials | `IMESSAGE_ENABLED=true` | `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` |
| Attachments out / tapbacks | as `chat-adapter-imessage` supports | yes |

The factory picks the backend deterministically: an explicit `IMESSAGE_BACKEND`
wins; otherwise Photon credentials imply hosted and `IMESSAGE_ENABLED` implies
local. If both are set without `IMESSAGE_BACKEND`, hosted wins (with a warning).

## Local backend (this Mac)

macOS only. The adapter reads the signed-in account's `chat.db`, which requires
**Full Disk Access** granted to the Node binary NanoClaw runs under. During
`/setup` (or `/add-imessage`) we open the Node binary's folder in Finder so you
can drag it into **System Settings → Privacy & Security → Full Disk Access**.

`.env`:

```bash
IMESSAGE_BACKEND=local
IMESSAGE_ENABLED=true
```

The DM `platform_id` / user id is the phone or email you iMessage with
(`imessage:+15551234567`).

## Hosted iMessage backend (via photon.codes)

Like Discord and Slack, Photon is a **persistent-connection** channel — no
public URL, no webhook, no signing secret. The `spectrum-ts` SDK holds a
long-lived **gRPC stream** to Photon for both directions. NanoClaw's host runs
on Node and `spectrum-ts` is a TypeScript SDK, so it runs **in-process on the
host** — no Python sidecar (as in Hermes), no loopback HTTP. `deliver()` /
`setTyping()` call the SDK directly; a re-subscribing consumer loop drains the
inbound stream.

```
                       gRPC (spectrum-ts, in-process)
┌─────────────────────────┐  ◄───────────────►  ┌──────────────────────────┐
│  Photon Spectrum cloud  │   app.messages       │  NanoClaw host (Node)    │
│  (iMessage line owner)  │   space.send()       │  imessage.ts (hosted)    │
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

### Credentials

Runtime SDK credentials live in `.env` (host-side; **never** enter a
container — delivery is host-side, and the container-runner does not mount
`.env` into agent containers):

```bash
PHOTON_PROJECT_ID=<spectrum project id>   # the SDK's projectId
PHOTON_PROJECT_SECRET=<project secret>
```

The device-login bearer token used during setup is cached in
`data/photon-auth.json` (mode `0600`) so re-running the wizard reuses it.

### Setup wizard

During first-time NanoClaw setup, choose **Yes, connect iMessage** and then
**Hosted iMessage**. That path asks for your iMessage phone number, runs the
Photon device login and provisioning wizard, installs the pinned runtime SDK,
restarts NanoClaw, and wires the DM to your first agent. It does not ask for a
server URL or API key.

`/add-imessage` (Hosted) provides the same flow for an existing installation.
The underlying commands are:

```bash
# 1. install the runtime SDK (pinned — spectrum-ts ships breaking majors)
pnpm install spectrum-ts@11.0.0

# 2. run the setup wizard (device login + guided provisioning; one manual step
#    — you text the assigned line once, and the wizard waits for it)
pnpm exec tsx scripts/photon-setup.ts --phone +15551234567
```

`scripts/photon-setup.ts` does, in order:

1. **Device login** (RFC 8628, `client_id=photon-cli`) — prints a URL + code,
   opens your browser, and polls until you approve. Talks only to Photon's
   dashboard HTTP API — it does not import `spectrum-ts`, so it works before the
   runtime SDK is installed.
2. **Find or create** the `NanoClaw` project on the Photon dashboard.
3. **Reuse the project's current secret** (regenerating only when the API
   returns none) and write `PHOTON_PROJECT_ID` + `PHOTON_PROJECT_SECRET` to
   `.env`.
4. **Register your phone and wait for its opt-in.** The wizard finds your
   Spectrum user row or creates one (`type: shared`), and prints the
   `assignedPhoneNumber` the row came back with. A new row never routes: the
   number only enters iMessage routing once it has sent one message to that
   assigned line, which is what flips the row's `meta.opt_in` server-side. The
   wizard polls the user list until it does — instant if the row is already
   opted in, and it never reports success before then.
5. **Surface the assigned iMessage line** — the number you text to reach your
   agent (the same one you texted to opt in).

Everything is idempotent: re-running reuses the stored token/project and the
existing user row, so it's safe to finish a partial setup. `pnpm exec tsx
scripts/photon-setup.ts status` shows what's configured, re-checking the opt-in
live.

After setup, restart the service so the adapter connects, then wire the DM to
an agent with `/init-first-agent` (the wizard prints a ready-to-run command).

### Configuration (hosted)

All optional, set in `.env`:

| Env var                              | Default                         | Meaning                                                                                  |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `PHOTON_PROJECT_ID`                  | — (required)                    | Spectrum project id (SDK `projectId`)                                                    |
| `PHOTON_PROJECT_SECRET`              | — (required)                    | Project secret                                                                           |
| `PHOTON_MARKDOWN`                    | `true`                          | Send agent replies as markdown (iMessage renders it natively). `false` sends plain text. |
| `PHOTON_TELEMETRY`                   | `false`                         | Enable Spectrum SDK telemetry                                                            |
| `PHOTON_MAX_INLINE_ATTACHMENT_BYTES` | `20971520` (20 MB)              | Max inbound attachment size the adapter reads + caches                                   |
| `PHOTON_DASHBOARD_HOST`              | `https://app.photon.codes`      | Management API host — device login and project provisioning (setup wizard)               |
| `PHOTON_SPECTRUM_HOST`               | `https://spectrum.photon.codes` | Spectrum API host (setup wizard)                                                         |

## Platform ids

- **DMs** are direct-addressable: the `platform_id` is the counterpart's bare
  E.164 number (e.g. `+15551234567`, or an email for the local backend), and the
  user id is `imessage:+15551234567` (see `src/platform-id.ts`).
- **Groups** (hosted) use the opaque Spectrum space id, discovered on first
  message.

## Features (hosted)

- **First contact is user-initiated** (intended Photon behavior) — the line can
  only message numbers that have already texted it; a cold outbound to an
  unknown number is rejected with `Target not allowed for this project`. Text
  your agent's number once before expecting anything back (this is why the
  wiring steps start with "text the number"). A welcome DM queued before that
  first inbound text simply fails delivery — it is not a NanoClaw bug.
- **Markdown** — replies are sent via the SDK's `markdown()` builder; iMessage
  renders bold/italics/lists/code natively. `PHOTON_MARKDOWN=false` reverts to
  plain text.
- **Inbound attachments & voice notes** — read off the stream (with retry on
  transient stream resets) and staged into the session's inbox by the host,
  surfaced to the agent as structured `attachments` (with a
  `[… could not be downloaded]` note on failure). Over-cap media is skipped.
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

The local backend's feature set is whatever `chat-adapter-imessage` and the
Chat SDK bridge provide.

## Upgrading spectrum-ts (hosted)

`spectrum-ts` is pinned to an **exact** version in `package.json` because the
SDK ships breaking majors (v11 is what the adapter targets). Upgrades are
deliberate:

1. Read the [SDK release notes][releases] for every version between the current
   pin and the target.
2. Bump the exact pin and run `pnpm install`.
3. Reconcile `src/channels/imessage.ts` against the new typings. The hosted
   backend uses `Spectrum`, the `imessage` provider, the `text` / `markdown` /
   `typing` / `read` / `attachment` / `voice` content builders, and
   `space.send` / `space.getMessage` / `message.react`.
4. Run `pnpm run build` and `pnpm exec vitest run src/channels/imessage.test.ts`.

## Troubleshooting

| Symptom                                 | Fix                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `spectrum-ts is not installed` at setup | Hosted backend: `pnpm install spectrum-ts@11.0.0`, then restart                                                        |
| `Target not allowed for this project`   | The number's user row is not opted in yet (`meta.opt_in` absent) — send one message from that phone to the line assigned to the row, then re-run setup (the line only messages numbers that have texted it first) |
| Device login times out                  | Re-run the wizard (the code expires in ~30 min; a stored token is reused)                                             |
| No iMessage line assigned               | The line comes back on your user row — re-run the wizard with `--phone` so the row is created, then `… photon-setup.ts status` |
| Inbound stops arriving (hosted)         | The adapter re-subscribes automatically; if it persists it's usually upstream — restart to force a fresh stream       |
| Local: no inbound                       | Confirm Full Disk Access is granted to the Node binary NanoClaw runs under, and that it runs on the signed-in Mac     |
| Bot silent (hosted)                     | Check `grep "Photon channel connected" logs/nanoclaw.log`, that the channel is wired, and that the service is running |

[photon]: https://photon.codes/
[adapter]: https://www.npmjs.com/package/chat-adapter-imessage
[releases]: https://github.com/photon-hq/spectrum-ts/releases
