# Run NanoClaw with the community portal

Use a fresh exe.dev VM with Docker, Node 22.13 or newer, pnpm 10.34.5 and native build
prerequisites. Bring your normal agent-provider credentials and access to a
Slack workspace where you can connect and install the managed app. The VM
needs no AWS, Vercel, WorkOS server or Slack server credentials.

```sh
git clone --branch feat/community-portal https://github.com/nanocoai/nanoclaw.git nanoclaw
cd nanoclaw
pnpm install --frozen-lockfile
pnpm setup:auto
```

Clone normally, without `--single-branch` or a shallow clone: channel installation
fetches the repository's `channels` branch. Do not copy another installation's
`.env`, `node_modules`, account files or setup journal. The Echo prebuilt image
path currently supports the Claude provider. Fresh setup selects Claude
automatically. An existing provider choice or explicit `NANOCLAW_AGENT_PROVIDER`
override is honored.

The portal opens at **https://portal.nanoclaw.dev** by default. The CLI asks
before opening the browser and prints the link for SSH users to open on their
laptop. WorkOS login establishes the browser session and authorizes the
originating installation through its activation choice. No tunnel, callback
listener, separate CLI login or pairing code is required.

## Walkthrough

1. Start setup and consent to the Echo offer. After WorkOS login, the dashboard
   opens with its activation modal. Enable Echo. The modal stays open with a success state and
   **Return to terminal** / **Browse other perks**. Setup starts continuing before
   either button is clicked. Verify the container step actually pulls the
   pinned Echo image; saving the choice alone does not prove the pull.
2. Connect Slack through its OAuth flow in the portal. At the Slack setup step,
   select your workspace. The browser goes directly to Slack's workspace
   installation screen if needed. Submit any admin approval request there; the
   CLI continues other setup. Once the admin approves, the saved background job
   installs the same app automatically and the portal updates to **Ready in Slack**.
   Confirm the agent replies in your Slack chat.
3. Already-enabled perks should be reused at subsequent setup stages. A skipped
   perk is offered again at its next applicable step. Tavily and Dial show
   **Coming soon** and are skipped by the CLI. No fake keys, credits, numbers,
   search results or calls are produced.
4. Interrupt and resume a setup step. It should reuse the pending request or
   saved Slack app rather than create duplicates. An ambiguous Slack create is
   held for recovery because the existing API has no idempotency contract.
5. Sign out of the browser. Account navigation should disappear immediately,
   including when the session expires. Signing the installation out from
   **Devices** should reject its old installation credential.

Revisit a step with `pnpm exec tsx setup/portal.ts --stage echo` or `--stage slack`,
one at a time. Private state is in `data/community-portal.json` and `data/slack-install.json`;
never share or commit either file. Keep that file when recovering an interrupted setup. Each checkout
retains its own installation identity.

The automated suite exercises the service, real cell, storage, CLI bridge and
browser UI. A completed WorkOS login, Echo image pull and real Slack reply on
your VM are the remaining operator acceptance checks. No VM or Slack app was
created by the preparation work.

## Background Slack installation

The detached worker survives closing the initiating terminal. Keep the VM on and
online. It checks approval at most once a minute for seven days, saves the bot
credential before acknowledging delivery, and then applies the existing Slack
channel skill with the captured agent name, operator role and owner ID. There are
no further input prompts in the worker. Foreground setup and the worker serialize
checkout changes using a transactional SQLite process lock.

Pending jobs resume on the next `pnpm setup:auto` or setup-step invocation after a
VM restart. To resume directly, use `pnpm exec tsx setup/portal.ts --stage slack`.
A failed build or wiring step is shown in the portal; retry that Slack step after
fixing the reported setup issue. Reuse the saved state. After the seven-day
approval window expires, review/revoke the old app and start a new installation;
the worker does not silently create a replacement.

Local automated checks cover the real detached process, a SIGKILL after credential
persistence, replayed acknowledgement, competing workers and the checkout lock.
Slack approval and message delivery still require the real-workspace walkthrough.

While approval is pending, final verification reports success for the running
NanoClaw service with `SLACK_INSTALL: awaiting_approval` (or `installing`) and
`WIRING: pending_slack_install`. The lack of Slack credentials or a wired group
at that point is expected. Failed or expired jobs still need attention. After
updating the branch, exit any older setup run and recheck with
`pnpm exec tsx setup/index.ts --step verify`; it also resumes the saved worker.

## Later offers and Slack approval scope

Before activation, Maybe later, the close button and Escape now skip the waiting CLI step. A success modal can close without cancelling installation. Setup makes one later browser offer for missing Echo (before service start, including the actual image pull) and Slack (before verification, using the same background job). Existing choices and saved apps are reused; unavailable partners are skipped.

The initial saved Slack job waits up to seven days and queues the welcome DM after approval, channel installation and owner wiring. Keep the VM and service running. Closing the terminal/browser is fine; a VM reboot requires a setup invocation to restart the saved job. Completion means the welcome handoff succeeded, not that Slack has acknowledged the agent reply.

Every newly created agent app may need separate admin approval. Agents created later from Slack currently wait five minutes, then park the saved app. After a later approval, ask the existing agent in Slack to “finish setting up <name>”; the app is reused. That runtime path does not yet share the initial installer’s durable background worker.
