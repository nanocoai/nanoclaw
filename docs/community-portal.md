# The community portal

[portal.nanoclaw.dev](https://portal.nanoclaw.dev) is the dashboard for the free NanoClaw account:
sign in, and switch on what the account offers. Today that is **Echo's hardened agent image** and a
**managed Slack app** for your agent (its manifest, avatar and workspace install are created for
you; no tokens to paste). No other perk is offered or started by the CLI. Everything else in
NanoClaw works without an account; see [Accounts and what leaves your machine](../README.md#accounts-and-what-leaves-your-machine).

Nothing here needs a special clone. Follow the [Quick Start](../README.md#quick-start) on `main`
and the wizard opens the portal at the Echo and Slack steps. `NANOCLAW_PORTAL_ORIGIN` points a
checkout at a different portal; leave it unset.

## How setup uses it

**Not signed in yet.** The wizard asks before opening a browser, then prints one link and opens
it. The page, "Approve your terminal", shows a short code and one button, "Sign in and approve".
Signing in there is the account sign-in (WorkOS, the OAuth device flow); approving binds this
machine to your account. The dashboard then opens with the perk's activation modal. Enable it and
the terminal continues on its own. Headless machine: the link, the code and the sign-in page are
printed on their own lines so you can open them from a phone or laptop.

**Already signed in** (from an earlier step, or from `bash setup/registry-login.sh`): the wizard
skips sign-in, makes sure this machine is registered at the portal, and opens the dashboard link.

**Enabling Echo** is where you agree to Echo's terms, including whether you want product and
security email from NanoClaw and from Echo. Only Echo carries terms; Slack activation is a
workspace connection and an app install.

**Skipping.** Close the modal, press Escape or choose "Maybe later" and the terminal continues
without the perk. Setup offers Echo once more before the service starts and Slack once more
before verification; decline and it does not ask again (`pnpm exec tsx setup/portal.ts --stage
echo` or `--stage slack` still works at any time).

Under the hood, for every stage: sign in if needed, ensure the device key, register the device
(`POST /api/v1/devices`, idempotent), start the stage, wait for the browser, apply the result,
report completion. The wizard polls the portal; nothing calls back into your machine.

## Files and locks on your machine

| File | Mode | Holds |
| --- | --- | --- |
| `~/.config/nanoclaw/account.json` | 0600 | The sign-in record and the install token. Written by the sign-in, never by the portal client. Per user, shared by every checkout on the machine. |
| `~/.config/nanoclaw/registry-auth.json` | 0600 | The docker credential helper's view of the same token. |
| `~/.config/nanoclaw/host-id` | 0600 | The per-machine install id the sign-in enrolled with. |
| `~/.config/nanoclaw/device-key.json` | 0600 | One P-256 key per machine, generated on first need. It signs the device proof on two requests only: device registration and the cell ticket. It never leaves the machine, and an unreadable file is an error, never a reason to mint a second identity. |
| `<checkout>/data/community-portal.json` | 0600 | This checkout's journal: the portal origin, the device id, setup progress, and the credentials a perk handed you. No key and no token. |
| `<checkout>/data/slack-install.json` | 0600 | The saved background Slack installation (below). |
| `data/community-portal.json.lock`, `data/setup-mutation.lock`, `data/slack-install.json.lock`, `data/community-portal-runtime.lock` | | Owner-stamped lock files; a crashed owner is recognised by its process birth time and reclaimed. |

The install token never passes through the browser: the browser sees the one-time sign-in code,
and the token reaches this machine from the account service. Every request to the portal carries
that token; the two requests above add the device proof. Never share or commit any of these
files; keep them when recovering an interrupted setup.

## Background Slack installation

A Slack app may need a workspace admin's approval, which can take days. Setup saves the job in
`data/slack-install.json` and starts a detached worker that survives closing the terminal. It checks
approval at most once a minute for seven days, saves the bot credential before acknowledging
delivery, then applies the Slack channel skill with the captured agent name, operator role and
owner, and queues the welcome message. There are no further prompts. The worker and foreground
setup serialise checkout changes through `data/setup-mutation.lock`.

The running NanoClaw service supervises the saved job and resumes it after a service or machine
restart, with the terminal and browser closed. Verification reports success while approval is
pending (`SLACK_INSTALL: awaiting_approval` or `installing`, `WIRING: pending_slack_install`); a
failed or expired job still fails it.

Recovery:

- Retry a failed job, or resume the Slack step after fixing what it reported:
  `pnpm exec tsx setup/portal.ts --stage slack`. The saved app is reused; a resumed setup never
  creates a duplicate.
- Re-check and resume the worker: `pnpm exec tsx setup/index.ts --step verify`.
- After the seven-day window expires the job is marked expired. Review or revoke the old app in
  the portal, then start a new installation with the command above.
- An ambiguous Slack create (the portal may have finished it) is held for you to review the agent
  list in the portal before recovering; setup will not repeat it on its own.

Agents created later from inside Slack wait five minutes for approval, then park the saved app;
after a later approval, ask the existing agent in Slack to finish setting it up. They do not use
the initial installer's worker.

## Presence and the link

**Devices** in the portal shows a machine as online while its host link is up. The host asks the
portal for a short-lived ticket (with the device proof), dials `wss://portal.nanoclaw.dev/cell/link`,
announces itself, pings every 20 seconds, and reconnects with a fresh ticket after a missed pong
or a dropped connection, backing off from one second to at most thirty. The portal drops a link
that stays silent for 65 seconds. Over the link the host receives only the account's perk
snapshot and device presence; it sends nothing about your agents, messages or files. Foreground
setup can hold the journal while the host stays connected; the service need not stop.

## Signing a machine out

Forget the machine under **Devices** in the portal. Its install token stops working at the
account service, the host is disconnected and logs `sign_in_required`, and the perk credentials in
the journal are dropped. Run a setup stage again to register the machine afresh under the same
account; `pnpm exec tsx setup/index.ts --step registry -- --status` shows the sign-in state.
Signing out of the browser only ends that browser session.

## Troubleshooting

- **The setup link expired.** Links are short-lived. Run the stage again for a fresh link and
  code; the saved journal is reused.
- **"Approve your terminal" keeps waiting.** The page advances once the terminal's sign-in has
  landed. Check that the terminal is still running the stage and that you completed the sign-in
  behind "Sign in and approve" (the code on the page must match the one the terminal printed). If
  the terminal was closed, run the stage again; the old page stays parked and expires on its own.
- **"This machine is registered under a different device key" (`device_pinned`).** The portal
  pinned another key for this machine: `device-key.json` was deleted and regenerated, or
  `account.json` was copied from another machine. Forget the device under **Devices**, then run
  the stage again. Never copy `account.json` or `device-key.json` between machines.
- **"Maximum number of devices" (`device_limit`).** An account holds ten live devices. Forget one
  you no longer use, then retry.
- **`sign_in_required` in the host log after forgetting a device.** Expected: the host stopped
  dialling because the identity is no longer valid. Run a setup stage to register again.
- **"Your NanoClaw sign-in is no longer valid here."** The token was revoked or expired. Sign in
  again with `pnpm exec tsx setup/index.ts --step registry`, then retry the stage.
- **"The device key at … could not be read."** The file exists but is unreadable or corrupt. Fix
  its permissions or remove it; a removed key means a new device identity, so forget the old
  device in the portal first.
- **`installation_required` (403) from a perk request.** The machine is signed in but not
  registered at the portal yet. Any setup stage registers it.
